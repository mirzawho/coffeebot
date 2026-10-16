import type { Db } from "../db/database";
import { nowIso } from "../db/database";
import { formatFullJalaliFa, formatJalaliFa, toPersianDigits, addDays } from "../utils/dates";
import { formatAmount } from "../utils/money";
import { log } from "../utils/logger";
import { BusinessHoursService } from "./business-hours";
import { NotificationService } from "./notifications";
import { getReportSettings } from "./settings";
import type { Order } from "./orders";
import { OrdersService } from "./orders";

const TELEGRAM_MESSAGE_LIMIT = 4000;
/** A `sending` report run older than this is abandoned (owning process died). */
export const STALE_RUN_MS = 5 * 60_000;
/**
 * Catch-up scan depth: walk back at most this many calendar days from the
 * current business date looking for dates that never got a terminal run row.
 * Bounds per-tick work and prevents ancient history from being regenerated.
 */
const CATCH_UP_DAYS = 14;

export interface ReportText {
  /** Ordered message chunks, each under Telegram's limit. */
  chunks: string[];
  orderCount: number;
}

/**
 * Build the Persian daily report text for a business date.
 * Payment lines reflect the real method and admin review state.
 */
export function buildDailyReportText(orders: Order[], businessDate: string): ReportText {
  const lines: string[] = [];
  lines.push(`📊 گزارش روزانه سفارش‌ها`);
  lines.push(`📅 ${formatFullJalaliFa(businessDate)}`);
  lines.push(`تعداد کل سفارش‌ها: ${toPersianDigits(String(orders.length))}`);
  if (orders.length === 0) {
    lines.push("امروز سفارشی ثبت نشده است.");
    return { chunks: [lines.join("\n")], orderCount: 0 };
  }
  lines.push("");
  for (const o of orders) {
    const time = o.createdAt.slice(11, 16);
    lines.push(`▫️ سفارش ${o.orderNumber}`);
    lines.push(
      `مشتری: ${o.customerName ?? "—"} | کاربر #${toPersianDigits(String(o.customerTelegramId))} | ثبت: ${toPersianDigits(time)}`,
    );
    for (const it of o.items) {
      const name = it.variantName ? `${it.productName} (${it.variantName})` : it.productName;
      lines.push(
        `  • ${name} ×${toPersianDigits(String(it.quantity))} — ${formatAmount(it.unitPrice)} × ${toPersianDigits(String(it.quantity))} = ${formatAmount(it.lineTotal)} ${o.currency}`,
      );
    }
    lines.push(`  جمع: ${formatAmount(o.totalAmount)} ${o.currency}`);
    if (o.deliveryNotes) lines.push(`  📦 تحویل: ${o.deliveryNotes}`);
    lines.push(`  ${paymentLine(o)}`);
    lines.push("");
  }
  const full = lines.join("\n");

  // Split into chunks while keeping order blocks together where possible.
  const chunks: string[] = [];
  if (full.length <= TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(full);
  } else {
    let current = "";
    for (const line of lines) {
      if ((current + "\n" + line).length > TELEGRAM_MESSAGE_LIMIT && current) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);
  }
  return { chunks, orderCount: orders.length };
}

export function buildOrderUpdateText(order: Order): { text: string; receiptFileId: string | null } {
  const lines: string[] = [];
  lines.push(`🔔 سفارش جدید پس از گزارش روزانه`);
  lines.push(`شماره سفارش: ${order.orderNumber}`);
  lines.push(`تاریخ کاری: ${formatJalaliFa(order.businessDate)}`);
  lines.push(`مشتری: ${order.customerName ?? "—"} | کاربر #${toPersianDigits(String(order.customerTelegramId))}`);
  for (const it of order.items) {
    const name = it.variantName ? `${it.productName} (${it.variantName})` : it.productName;
    lines.push(`• ${name} ×${toPersianDigits(String(it.quantity))} — ${formatAmount(it.lineTotal)} ${order.currency}`);
  }
  lines.push(`جمع: ${formatAmount(order.totalAmount)} ${order.currency}`);
  if (order.deliveryNotes) lines.push(`تحویل: ${order.deliveryNotes}`);
  lines.push(paymentLine(order));
  return { text: lines.join("\n"), receiptFileId: order.receiptFileId };
}

/** One-line payment summary: method + whether the money is actually settled. */
export function paymentLine(order: Order): string {
  if (order.paymentMethod === "wallet") {
    return `💰 پرداخت: کیف پول — ${order.paymentStatus === "paid" ? "کسر شد" : "تأیید نشده"}`;
  }
  if (order.paymentStatus === "paid") return "💳 پرداخت: کارت به کارت — تأیید شده";
  if (order.paymentStatus === "rejected") return "💳 پرداخت: کارت به کارت — رسید رد شده";
  return `💳 پرداخت: کارت به کارت — ${order.receiptFileId ? "رسید دریافت شده، در انتظار تأیید" : "رسیدی ارسال نشده"}`;
}

export type ClaimOutcome =
  | { action: "enqueued"; businessDate: string; orderCount: number; recipients: number[] }
  | { action: "skipped_empty"; businessDate: string }
  | { action: "disabled" }
  | { action: "no_recipients"; businessDate: string }
  | { action: "already_claimed"; businessDate: string }
  | { action: "failed"; businessDate: string; error: string }
  | { action: "noop" };

/**
 * Decide whether the daily report for the current moment is due, claim the
 * report_runs row atomically, and enqueue per-recipient notifications.
 * Delivery (and delivery confirmation) is handled by the notification queue.
 */
export class ReportService {
  private orders: OrdersService;

  constructor(
    private readonly db: Db,
    private readonly businessHours: BusinessHoursService,
    private readonly notifications: NotificationService,
    private readonly timezone: string,
  ) {
    this.orders = new OrdersService(db, businessHours);
  }

  /**
   * Check whether a report is due at `now` and claim it.
   * Returns the business date that should be reported, or null if not due.
   */
  dueBusinessDate(now: Date): string | null {
    const settings = getReportSettings(this.db);
    if (!settings.enabled) return null;
    const { date, time } = zonedParts(now, this.timezone);
    const [rh, rm] = settings.time.split(":").map(Number) as [number, number];
    const [nh, nm] = time.split(":").map(Number) as [number, number];
    const dueMinutes = rh * 60 + rm;
    const nowMinutes = nh * 60 + nm;
    if (nowMinutes < dueMinutes) return null;
    return this.businessHours.reportBusinessDate(now);
  }

  /** All outstanding business dates that are due (missed while offline or pending). */
  findDueReports(now: Date): string[] {
    if (!getReportSettings(this.db).enabled) return [];
    const businessDate = this.dueBusinessDate(now);
    const candidates = new Set<string>();

    // 1. Current business date, but only once its scheduled time has passed.
    if (businessDate) candidates.add(businessDate);

    // 2. Catch-up: walk back from the current business date looking for dates
    //    that never received a terminal run row (sent/skipped_empty). A date
    //    with any non-terminal row (pending/sending/failed) is re-attempted by
    //    trySend's claim; a date with a terminal row is never regenerated.
    //    This recovers reports missed because the app was fully offline at the
    //    scheduled moment (no run row was ever created).
    const today = businessDate ?? zonedParts(now, this.timezone).date;
    let walk = today;
    for (let i = 0; i < CATCH_UP_DAYS; i++) {
      const run = this.db
        .query("SELECT status FROM report_runs WHERE business_date = ?")
        .get(walk) as { status: string } | null;
      if (run === null) {
        // Never processed. Only enqueue catch-up for dates strictly before
        // today — the current date is handled by the due-time gate above.
        if (walk < today) candidates.add(walk);
      } else if (run.status !== "sent" && run.status !== "skipped_empty") {
        // Incomplete (pending/sending/failed) — retry via trySend.
        candidates.add(walk);
      }
      walk = addDays(walk, -1);
    }

    // 3. Any older incomplete runs beyond the walk window (e.g. long outage).
    const runs = this.db
      .query("SELECT business_date, status FROM report_runs WHERE status IN ('pending','sending','failed')")
      .all() as { business_date: string; status: string }[];
    for (const r of runs) {
      if (r.business_date <= today) candidates.add(r.business_date);
    }

    return [...candidates].sort();
  }

  /**
   * Recover report runs stuck in `sending` longer than STALE_RUN_MS (the
   * owning process crashed mid-claim). Reset to `pending` so trySend can
   * re-claim them; the per-date UNIQUE row keeps generation idempotent.
   */
  recoverStaleSendingRuns(now = new Date(), olderThanMs = STALE_RUN_MS): number {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
    const res = this.db
      .query(
        `UPDATE report_runs SET status = 'pending'
         WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?)`,
      )
      .run(cutoff);
    return res.changes;
  }

  /**
   * Attempt to generate+enqueue the report for a business date.
   * Idempotent: report_runs has one row per business_date; claim is atomic.
   */
  trySend(businessDate: string, now = new Date()): ClaimOutcome {
    const settings = getReportSettings(this.db);
    if (!settings.enabled) return { action: "disabled" };
    const recipients = settings.recipients;
    if (recipients.length === 0) return { action: "no_recipients", businessDate };

    // Create run row if missing.
    this.db
      .query(
        `INSERT INTO report_runs (business_date, status, attempts, created_at)
         VALUES (?, 'pending', 0, ?)
         ON CONFLICT(business_date) DO NOTHING`,
      )
      .run(businessDate, nowIso());

    // Atomic claim: only one processor may move pending -> sending.
    const claim = this.db
      .query(
        `UPDATE report_runs SET status = 'sending', attempts = attempts + 1, claimed_at = ?
         WHERE business_date = ? AND status IN ('pending', 'failed')`,
      )
      .run(now.toISOString(), businessDate);
    if (claim.changes !== 1) {
      return { action: "already_claimed", businessDate };
    }

    try {
      const orders = this.orders.listByBusinessDate(businessDate);
      if (orders.length === 0 && !settings.sendEmpty) {
        this.db
          .query(
            "UPDATE report_runs SET status = 'skipped_empty', sent_at = ?, error = NULL WHERE business_date = ?",
          )
          .run(nowIso(), businessDate);
        return { action: "skipped_empty", businessDate };
      }
      this.notifications.enqueue("daily_report", businessDate, recipients, {
        type: "daily_report",
        businessDate,
      });
      this.db
        .query("UPDATE report_runs SET status = 'sent', sent_at = ?, error = NULL WHERE business_date = ?")
        .run(nowIso(), businessDate);
      this.db
        .query(
          "INSERT INTO settings (key, value) VALUES ('last_report_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(`ارسال‌شده ${businessDate} (${orders.length} سفارش)`);
      this.db
        .query(
          "INSERT INTO settings (key, value) VALUES ('last_report_error', '') ON CONFLICT(key) DO UPDATE SET value = ''",
        )
        .run();
      log.info("daily report enqueued", { businessDate, orders: orders.length, recipients: recipients.length });
      return { action: "enqueued", businessDate, orderCount: orders.length, recipients };
    } catch (err) {
      const msg = String(err).slice(0, 500);
      this.db
        .query("UPDATE report_runs SET status = 'failed', error = ? WHERE business_date = ?")
        .run(msg, businessDate);
      this.db
        .query(
          "INSERT INTO settings (key, value) VALUES ('last_report_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(msg);
      log.error("daily report failed", { businessDate, err: msg });
      // A genuine generation/enqueue failure is distinct from a duplicate
      // claim: the run is left 'failed' so the next tick retries it.
      return { action: "failed", businessDate, error: msg };
    }
  }

  recentRuns(limit = 7): { businessDate: string; status: string; sentAt: string | null; error: string | null }[] {
    const rows = this.db
      .query("SELECT business_date, status, sent_at, error FROM report_runs ORDER BY business_date DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map((r) => ({
      businessDate: r.business_date,
      status: r.status,
      sentAt: r.sent_at ?? null,
      error: r.error ?? null,
    }));
  }

  /** Payload for a daily_report notification — message chunks built at send time. */
  buildReportPayload(businessDate: string): ReportText {
    return buildDailyReportText(this.orders.listByBusinessDate(businessDate), businessDate);
  }
}

function zonedParts(now: Date, timeZone: string): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // en-CA gives YYYY-MM-DD; build parts manually for reliability.
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let hour = Number(parts.hour ?? "0");
  if (hour === 24) hour = 0;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${String(hour).padStart(2, "0")}:${parts.minute}`;
  return { date, time };
}
