import type { Db } from "../db/database";
import { nowIso } from "../db/database";
import { log } from "../utils/logger";

export type NotificationKind = "daily_report" | "order_update" | "customer_notice";
export type NotificationStatus = "pending" | "sending" | "sent" | "failed";

export interface NotificationRow {
  id: number;
  kind: NotificationKind;
  recipientId: number;
  refKey: string;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: string | null;
  payload: string;
  error: string | null;
  deliveredChunks: number;
}

const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000; // 30s, 60s, 120s... capped at 30min
/**
 * A `sending` claim older than this is considered abandoned (owning process
 * crashed or hung) and may be recovered. Delivery is an HTTP call that should
 * finish in seconds; 5 minutes is far beyond any healthy in-flight send.
 */
export const STALE_SENDING_MS = 5 * 60_000;

export function backoffMs(attempts: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
  return exp;
}

/**
 * Persistent notification queue with idempotent enqueue and atomic claim,
 * so restarts and accidental multi-instance starts do not duplicate sends.
 */
export class NotificationService {
  constructor(private readonly db: Db) {}

  enqueue(kind: NotificationKind, refKey: string, recipientIds: number[], payload: unknown): number {
    const body = JSON.stringify(payload);
    const now = nowIso();
    const insert = this.db.query(
      `INSERT INTO notifications (kind, recipient_id, ref_key, status, attempts, next_attempt_at, payload, created_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(kind, ref_key, recipient_id) DO NOTHING`,
    );
    let queued = 0;
    this.db.transaction(() => {
      for (const recipient of recipientIds) {
        if (!Number.isInteger(recipient) || recipient <= 0) continue;
        const res = insert.run(kind, recipient, refKey, now, body, now);
        queued += res.changes;
      }
    })();
    return queued;
  }

  /** Atomically claim up to `limit` due notifications (pending + backoff elapsed). */
  claimDue(now = new Date(), limit = 10): NotificationRow[] {
    const nowIsoStr = now.toISOString();
    const claimed: NotificationRow[] = [];
    const due = this.db
      .query(
        `SELECT * FROM notifications
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id LIMIT ?`,
      )
      .all(nowIsoStr, limit) as any[];
    for (const row of due) {
      const res = this.db
        .query(
          `UPDATE notifications SET status = 'sending', claimed_at = ?
           WHERE id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        )
        .run(nowIsoStr, row.id, nowIsoStr);
      if (res.changes === 1) {
        claimed.push(this.mapRow({ ...row, claimed_at: nowIsoStr }));
      }
    }
    return claimed;
  }

  /**
   * Recover notifications stuck in `sending` longer than STALE_SENDING_MS —
   * the owning process crashed or hung mid-delivery. Counts as an attempt
   * (delivery may or may not have reached Telegram; duplicates are possible
   * but bounded by MAX_ATTEMPTS). Atomic per-row and idempotent: rows already
   * moved by another recovery pass are skipped by the status guard.
   */
  recoverStaleSending(now = new Date(), olderThanMs = STALE_SENDING_MS): number {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
    const nowIsoStr = now.toISOString();
    const stale = this.db
      .query(
        `SELECT id, attempts FROM notifications
         WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?)`,
      )
      .all(cutoff) as { id: number; attempts: number }[];
    let recovered = 0;
    for (const row of stale) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        const res = this.db
          .query(
            `UPDATE notifications SET status = 'failed', attempts = ?, error = ?, next_attempt_at = NULL
             WHERE id = ? AND status = 'sending'`,
          )
          .run(attempts, "delivery abandoned (process crash/hang)", row.id);
        recovered += res.changes;
      } else {
        const next = new Date(now.getTime() + backoffMs(attempts)).toISOString();
        const res = this.db
          .query(
            `UPDATE notifications SET status = 'pending', attempts = ?, error = ?, next_attempt_at = ?
             WHERE id = ? AND status = 'sending'`,
          )
          .run(attempts, "delivery interrupted; retrying", next, row.id);
        recovered += res.changes;
      }
    }
    return recovered;
  }

  /** Record how many report chunks were durably delivered (cursor for retry). */
  saveChunkProgress(id: number, deliveredChunks: number): void {
    this.db
      .query("UPDATE notifications SET delivered_chunks = ? WHERE id = ?")
      .run(deliveredChunks, id);
  }

  markSent(id: number): void {
    this.db
      .query("UPDATE notifications SET status = 'sent', error = NULL WHERE id = ? AND status = 'sending'")
      .run(id);
  }

  /**
   * Record a failed attempt. Retries with bounded exponential backoff up to
   * MAX_ATTEMPTS, then keeps the row as 'failed' with the last error retained.
   */
  markFailed(id: number, error: string): void {
    const row = this.db.query("SELECT attempts FROM notifications WHERE id = ?").get(id) as
      | { attempts: number }
      | null;
    if (!row) return;
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.db
        .query(
          "UPDATE notifications SET status = 'failed', attempts = ?, error = ?, next_attempt_at = NULL WHERE id = ?",
        )
        .run(attempts, error.slice(0, 500), id);
    } else {
      const next = new Date(Date.now() + backoffMs(attempts)).toISOString();
      this.db
        .query(
          "UPDATE notifications SET status = 'pending', attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?",
        )
        .run(attempts, error.slice(0, 500), next, id);
    }
  }

  private mapRow(r: any): NotificationRow {
    return {
      id: r.id,
      kind: r.kind,
      recipientId: r.recipient_id,
      refKey: r.ref_key,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at ?? null,
      payload: r.payload,
      error: r.error ?? null,
      deliveredChunks: r.delivered_chunks ?? 0,
    };
  }

  /** True when every daily_report notification for this business date was delivered. */
  allReportDelivered(businessDate: string): boolean {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
         FROM notifications WHERE kind = 'daily_report' AND ref_key = ?`,
      )
      .get(businessDate) as { total: number; sent: number | null };
    if (row.total === 0) return false;
    return row.total === (row.sent ?? 0);
  }

  counts(): { pending: number; failed: number } {
    const pending = (
      this.db.query("SELECT COUNT(*) AS c FROM notifications WHERE status IN ('pending','sending')").get() as {
        c: number;
      }
    ).c;
    const failed = (
      this.db.query("SELECT COUNT(*) AS c FROM notifications WHERE status = 'failed'").get() as {
        c: number;
      }
    ).c;
    return { pending, failed };
  }
}
