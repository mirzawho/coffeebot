import type { Bot } from "grammy";
import type { Db } from "../db/database";
import type { BusinessHoursService } from "../services/business-hours";
import type { NotificationService, NotificationRow } from "../services/notifications";
import type { ReportService } from "../services/reports";
import type { OrdersService } from "../services/orders";
import { buildOrderUpdateText } from "../services/reports";
import { receiptReviewKeyboard } from "../bot/keyboards";
import { receiptPendingCaption } from "../bot/format";
import { log } from "../utils/logger";

const TICK_MS = 30_000;

export interface SchedulerDeps {
  db: Db;
  bot: Bot;
  reports: ReportService;
  notifications: NotificationService;
  businessHours: BusinessHoursService;
  orders: OrdersService;
}

/**
 * Lightweight in-process scheduler:
 *  - ticks every 30s
 *  - claims due daily reports (including ones missed while offline)
 *  - claims due notifications and delivers them via the Telegram bot
 * Single-host design: atomic SQLite claims prevent duplicate processing if a
 * second instance is started accidentally.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    log.info("scheduler started", { tickMs: TICK_MS });
    // Kick once immediately to recover anything missed while offline.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("scheduler stopped");
  }

  /** Run one tick now (also used by tests). */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.processDueReports();
      await this.processNotifications();
    } catch (err) {
      log.error("scheduler tick error", { err: String(err) });
    } finally {
      this.running = false;
    }
  }

  private processDueReports(): void {
    const now = new Date();
    // First, un-stick any report run whose owning process crashed mid-claim.
    const recovered = this.deps.reports.recoverStaleSendingRuns(now);
    if (recovered > 0) log.warn("recovered stale report runs", { count: recovered });
    const due = this.deps.reports.findDueReports(now);
    for (const businessDate of due) {
      const outcome = this.deps.reports.trySend(businessDate, now);
      if (outcome.action === "failed") {
        // Genuine generation/enqueue failure — surface it (the run stays
        // 'failed' and is retried on a later tick).
        log.error("report generation failed", { businessDate, err: outcome.error });
      } else if (outcome.action !== "already_claimed" && outcome.action !== "disabled") {
        log.info("report processed by scheduler", { businessDate, outcome: outcome.action });
      }
    }
  }

  private async processNotifications(): Promise<void> {
    // Un-stick notifications whose owning process crashed mid-delivery.
    // Duplicate delivery is possible for the interrupted send (bounded by
    // MAX_ATTEMPTS); the chunk cursor avoids re-sending completed chunks.
    const recovered = this.deps.notifications.recoverStaleSending(new Date());
    if (recovered > 0) log.warn("recovered stale notifications", { count: recovered });
    const due = this.deps.notifications.claimDue(new Date(), 10);
    for (const n of due) {
      try {
        await this.deliver(n);
        this.deps.notifications.markSent(n.id);
        this.maybeFinalizeReportRun(n);
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        this.deps.notifications.markFailed(n.id, msg);
        log.warn("notification delivery failed", {
          id: n.id,
          kind: n.kind,
          recipient: n.recipientId,
          err: msg.slice(0, 200),
        });
      }
    }
  }

  private async deliver(n: NotificationRow): Promise<void> {
    const payload = JSON.parse(n.payload) as { type: string; orderId?: number; businessDate?: string };

    if (n.kind === "daily_report") {
      const businessDate = payload.businessDate ?? n.refKey;
      const report = this.deps.reports.buildReportPayload(businessDate);
      // Resume from the durable chunk cursor so a retry after a partial
      // failure does not resend chunks already delivered. If the process
      // crashes between Telegram accepting a chunk and the cursor update,
      // that one chunk may be duplicated — unavoidable without Telegram-side
      // idempotency; all later chunks still resume correctly.
      let cursor = n.deliveredChunks ?? 0;
      for (let i = cursor; i < report.chunks.length; i++) {
        await this.deps.bot.api.sendMessage(n.recipientId, report.chunks[i]!);
        cursor = i + 1;
        this.deps.notifications.saveChunkProgress(n.id, cursor);
      }
      return;
    }

    if (n.kind === "customer_notice") {
      // Direct customer message; payload carries the final text and optionally
      // a receipt photo (rejection notices send image + reason together).
      const notice = JSON.parse(n.payload) as { text?: string; photoFileId?: string };
      if (!notice.text) throw new Error("customer_notice payload missing text");
      if (notice.photoFileId) {
        // One atomic sendPhoto: a retry after a partial failure can never
        // double-send, and the reason rides as the caption (short by design).
        await this.deps.bot.api.sendPhoto(n.recipientId, notice.photoFileId, {
          caption: notice.text.slice(0, 1024),
        });
      } else {
        await this.deps.bot.api.sendMessage(n.recipientId, notice.text);
      }
      return;
    }

    if (n.kind === "wallet_adjustment") {
      // Admin changed the customer's balance: tell them what and why.
      const notice = JSON.parse(n.payload) as { text?: string };
      if (!notice.text) throw new Error("wallet_adjustment payload missing text");
      await this.deps.bot.api.sendMessage(n.recipientId, notice.text);
      return;
    }

    if (n.kind === "order_update") {
      if (!payload.orderId) throw new Error("order_update payload missing orderId");
      const order = this.deps.orders.loadOrder(payload.orderId);
      if (!order) throw new Error(`order ${payload.orderId} not found`);
      const { text, receiptFileId } = buildOrderUpdateText(order);
      await this.deps.bot.api.sendMessage(n.recipientId, text);
      if (receiptFileId) {
        // The photo carries the review buttons (تأیید/لغو). If Telegram cannot
        // re-send the file, fall back to a text message with the SAME keyboard
        // so the admin still gets an actionable prompt.
        const reviewKb = receiptReviewKeyboard(order.id);
        try {
          const sent = await this.deps.bot.api.sendPhoto(n.recipientId, receiptFileId, {
            caption: receiptPendingCaption(order.orderNumber),
            reply_markup: reviewKb,
          });
          // Remember the message id so a later review decision (bot button or
          // admin panel) can rewrite the caption in place.
          this.deps.notifications.recordMessageId(n.id, sent.message_id);
        } catch (photoErr) {
          log.warn("receipt forward failed", { err: String(photoErr) });
          await this.deps.bot.api.sendMessage(n.recipientId, `🧾 رسید سفارش ${order.orderNumber}`, {
            reply_markup: reviewKb,
          });
        }
      }
      return;
    }

    throw new Error(`unknown notification kind: ${n.kind}`);
  }

  /**
   * When all recipients of a daily_report have been delivered, record the run
   * outcome for the admin dashboard. Idempotent.
   */
  private maybeFinalizeReportRun(n: NotificationRow): void {
    if (n.kind !== "daily_report") return;
    if (!this.deps.notifications.allReportDelivered(n.refKey)) return;
    this.deps.db
      .query(
        `INSERT INTO settings (key, value) VALUES ('last_report_status', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(`ارسال کامل ${n.refKey}`);
    this.deps.db
      .query(
        `INSERT INTO settings (key, value) VALUES ('last_report_error', '')
         ON CONFLICT(key) DO UPDATE SET value = ''`,
      )
      .run();
  }
}
