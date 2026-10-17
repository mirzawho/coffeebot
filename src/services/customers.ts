import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";
import { log } from "../utils/logger";

/**
 * Customer profiles + wallet. Identity is the stable Telegram user id.
 * Wallet integrity rules:
 *  - balance column mirrors SUM(wallet_transactions.amount) and both are
 *    updated inside the same IMMEDIATE transaction;
 *  - the UNIQUE(kind, ref_type, ref_id, telegram_id) index on the ledger makes
 *    every deposit credit / order debit idempotent (retries cannot double-apply);
 *  - ledger rows are never deleted; corrections use explicit adjustment rows.
 */

export interface CustomerProfile {
  telegramId: number;
  /** Single display name (the bot edits it as one field). Mirrors first_name. */
  fullName: string;
  phone: string | null;
  address: string | null;
  username: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletState {
  telegramId: number;
  balance: number;
}

export interface WalletTransaction {
  id: number;
  telegramId: number;
  amount: number;
  kind: "deposit" | "order_payment" | "refund" | "adjustment";
  refType: "deposit" | "order";
  refId: number;
  balanceAfter: number;
  note: string | null;
  createdBy: number | null;
  createdAt: string;
}

export interface WalletDeposit {
  id: number;
  telegramId: number;
  amount: number;
  status: "pending" | "approved" | "rejected";
  receiptFileId: string | null;
  receiptMessageId: number | null;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
}

export const MAX_WALLET_BALANCE = 100_000_000;
export const MAX_DEPOSIT_AMOUNT = 10_000_000;
export const MAX_PHONE_LENGTH = 20;
export const MAX_NAME_LENGTH = 80;
export const MAX_ADDRESS_LENGTH = 300;

/** Normalize a phone number: keep leading + and digits; Persian digits converted. */
export function normalizePhone(raw: string): string | null {
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  let s = String(raw ?? "").trim();
  s = s.replace(/[۰-۹]/g, (d) => String(persian.indexOf(d)));
  s = s.replace(/[٠-٩]/g, (d) => String(arabic.indexOf(d)));
  s = s.replace(/[\s\-().]/g, "");
  if (!s) return null;
  if (s.startsWith("+989")) s = "0" + s.slice(3);
  else if (s.startsWith("00989")) s = "0" + s.slice(4);
  else if (s.startsWith("989")) s = "0" + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = `0${s}`;
  if (!/^09\d{9}$/.test(s)) return null;
  return s;
}

export class CustomersService {
  constructor(private readonly db: Db) {}

  // ---------- profile ----------

  getProfile(telegramId: number): CustomerProfile | null {
    const r = this.db
      .query("SELECT * FROM customer_profiles WHERE telegram_id = ?")
      .get(telegramId) as any;
    if (!r) return null;
    return {
      telegramId: r.telegram_id,
      fullName: (r.full_name ?? r.first_name ?? "").trim(),
      phone: r.phone ?? null,
      address: r.address ?? null,
      username: r.username ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Capture Telegram identity seen on a validated update. Upserts a profile
   * row (a customer's first order may be their first ever touch) with the
   * sender's real name/username. An explicit profile edit is authoritative, so
   * existing non-empty name fields are never overwritten — only blanks are
   * filled. The username is always refreshed (it isn't user-editable).
   */
  recordSender(
    telegramId: number,
    sender: { firstName?: string | null; lastName?: string | null; username?: string | null },
  ): void {
    const fullName =
      [sender.firstName, sender.lastName]
        .filter(Boolean)
        .join(" ")
        .trim()
        .slice(0, MAX_NAME_LENGTH) || null;
    const username = String(sender.username ?? "").trim().slice(0, 64) || null;
    if (!fullName && !username) return;
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO customer_profiles (telegram_id, first_name, full_name, username, created_at, updated_at)
         VALUES (?, COALESCE(?, ''), ?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           first_name = CASE WHEN customer_profiles.first_name = '' THEN COALESCE(excluded.first_name, customer_profiles.first_name) ELSE customer_profiles.first_name END,
           full_name = COALESCE(customer_profiles.full_name, excluded.first_name),
           username = COALESCE(excluded.username, customer_profiles.username),
           updated_at = excluded.updated_at`,
      )
      .run(telegramId, fullName, fullName, username, now, now);
  }

  /** Create or update the caller's own profile. Returns the saved profile. */
  saveProfile(
    telegramId: number,
    input: { fullName: string; phone?: string | null; address?: string | null },
  ): { ok: true; profile: CustomerProfile } | { ok: false; error: string } {
    const fullName = String(input.fullName ?? "").trim();
    if (!fullName) return { ok: false, error: "نام را وارد کنید" };
    if (fullName.length > MAX_NAME_LENGTH) {
      return { ok: false, error: "نام بیش از حد مجاز طولانی است" };
    }
    let phone: string | null = null;
    if (input.phone !== undefined && input.phone !== null && String(input.phone).trim() !== "") {
      phone = normalizePhone(String(input.phone));
      if (!phone) {
        return { ok: false, error: "شماره موبایل معتبر نیست (مثلاً 09123456789)" };
      }
    }
    const address =
      input.address === undefined
        ? (this.getProfile(telegramId)?.address ?? null)
        : String(input.address ?? "").trim().slice(0, MAX_ADDRESS_LENGTH) || null;
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO customer_profiles (telegram_id, first_name, full_name, phone, address, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET first_name = excluded.first_name,
           full_name = excluded.full_name, phone = COALESCE(excluded.phone, customer_profiles.phone),
           address = excluded.address,
           updated_at = excluded.updated_at`,
      )
      .run(telegramId, fullName, fullName, phone, address, now, now);
    return { ok: true, profile: this.getProfile(telegramId)! };
  }

  /** Profile completeness for checkout prompts. */
  isProfileComplete(telegramId: number): boolean {
    const p = this.getProfile(telegramId);
    return !!p && !!p.phone;
  }

  // ---------- wallet ----------

  getBalance(telegramId: number): number {
    const row = this.db
      .query("SELECT balance FROM wallets WHERE telegram_id = ?")
      .get(telegramId) as { balance: number } | null;
    return row?.balance ?? 0;
  }

  private ensureWallet(telegramId: number): void {
    this.db
      .query(
        "INSERT INTO wallets (telegram_id, balance, created_at, updated_at) VALUES (?, 0, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(telegramId, nowIso(), nowIso());
  }

  listTransactions(telegramId: number, limit = 20): WalletTransaction[] {
    const rows = this.db
      .query(
        "SELECT * FROM wallet_transactions WHERE telegram_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(telegramId, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      telegramId: r.telegram_id,
      amount: r.amount,
      kind: r.kind,
      refType: r.ref_type,
      refId: r.ref_id,
      balanceAfter: r.balance_after,
      note: r.note ?? null,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
    }));
  }

  /**
   * Apply a ledger entry + balance update atomically. Idempotent per
   * (kind, refType, refId, telegramId): a repeated apply is a no-op returning
   * the existing transaction. `expectedBalance` enables optimistic concurrency
   * for spends (prevents overspend between two concurrent checkouts).
   */
  private applyLedger(
    telegramId: number,
    amount: number,
    kind: WalletTransaction["kind"],
    refType: WalletTransaction["refType"],
    refId: number,
    opts?: { createdBy?: number | null; note?: string | null; expectedBalance?: number },
  ): { applied: boolean; tx: WalletTransaction } {
    return tx(this.db, () => {
      const existing = this.db
        .query(
          "SELECT * FROM wallet_transactions WHERE kind = ? AND ref_type = ? AND ref_id = ? AND telegram_id = ?",
        )
        .get(kind, refType, refId, telegramId) as any;
      if (existing) return { applied: false, tx: this.rowToTx(existing) };

      const balanceBefore = this.getBalance(telegramId);
      if (opts?.expectedBalance !== undefined && balanceBefore !== opts.expectedBalance) {
        throw new Error("WALLET_CONCURRENCY");
      }
      const balanceAfter = balanceBefore + amount;
      if (balanceAfter < 0) throw new Error("WALLET_INSUFFICIENT");
      if (balanceAfter > MAX_WALLET_BALANCE) throw new Error("WALLET_LIMIT");

      this.ensureWallet(telegramId);
      const res = this.db
        .query(
          `INSERT INTO wallet_transactions (telegram_id, amount, kind, ref_type, ref_id, balance_after, note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          telegramId,
          amount,
          kind,
          refType,
          refId,
          balanceAfter,
          opts?.note ?? null,
          opts?.createdBy ?? null,
          nowIso(),
        );
      this.db
        .query("UPDATE wallets SET balance = ?, updated_at = ? WHERE telegram_id = ?")
        .run(balanceAfter, nowIso(), telegramId);
      return {
        applied: true,
        tx: this.rowToTx(
          this.db
            .query("SELECT * FROM wallet_transactions WHERE id = ?")
            .get(Number(res.lastInsertRowid)) as any,
        ),
      };
    });
  }

  private rowToTx(r: any): WalletTransaction {
    return {
      id: r.id,
      telegramId: r.telegram_id,
      amount: r.amount,
      kind: r.kind,
      refType: r.ref_type,
      refId: r.ref_id,
      balanceAfter: r.balance_after,
      note: r.note ?? null,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
    };
  }

  // ---------- deposits ----------

  createDeposit(telegramId: number, amount: number): { ok: true; deposit: WalletDeposit } | { ok: false; error: string } {
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: "مبلغ شارژ باید عددی مثبت باشد" };
    }
    if (amount > MAX_DEPOSIT_AMOUNT) {
      return { ok: false, error: `حداکثر مبلغ شارژ ${MAX_DEPOSIT_AMOUNT.toLocaleString("en-US")} است` };
    }
    // A profile row is required by the FK; create a minimal one if absent.
    if (!this.getProfile(telegramId)) {
      this.saveProfile(telegramId, { fullName: "مشتری" });
    }
    const now = nowIso();
    const res = this.db
      .query(
        `INSERT INTO wallet_deposits (telegram_id, amount, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(telegramId, amount, now, now);
    return { ok: true, deposit: this.getDeposit(Number(res.lastInsertRowid))! };
  }

  getDeposit(id: number): WalletDeposit | null {
    const r = this.db.query("SELECT * FROM wallet_deposits WHERE id = ?").get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      telegramId: r.telegram_id,
      amount: r.amount,
      status: r.status,
      receiptFileId: r.receipt_file_id ?? null,
      receiptMessageId: r.receipt_message_id ?? null,
      reviewedBy: r.reviewed_by ?? null,
      reviewedAt: r.reviewed_at ?? null,
      createdAt: r.created_at,
    };
  }

  /** The customer's most recent pending deposit (receipt routing). */
  latestPendingDeposit(telegramId: number): WalletDeposit | null {
    const r = this.db
      .query(
        "SELECT id FROM wallet_deposits WHERE telegram_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      )
      .get(telegramId) as { id: number } | null;
    return r ? this.getDeposit(r.id) : null;
  }

  attachDepositReceipt(
    telegramId: number,
    depositId: number,
    fileId: string,
    messageId: number,
  ): { ok: true } | { ok: false; error: string } {
    const d = this.getDeposit(depositId);
    if (!d || d.telegramId !== telegramId) return { ok: false, error: "درخواست شارژ یافت نشد" };
    if (d.status !== "pending") return { ok: false, error: "این درخواست قبلاً بررسی شده است" };
    this.db
      .query(
        "UPDATE wallet_deposits SET receipt_file_id = ?, receipt_message_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(fileId, messageId, nowIso(), depositId);
    return { ok: true };
  }

  listDeposits(telegramId: number, limit = 10): WalletDeposit[] {
    const rows = this.db
      .query("SELECT id FROM wallet_deposits WHERE telegram_id = ? ORDER BY id DESC LIMIT ?")
      .all(telegramId, limit) as { id: number }[];
    return rows.map((r) => this.getDeposit(r.id)!);
  }

  listAllDeposits(status: "pending" | "approved" | "rejected" | "all", limit = 30): WalletDeposit[] {
    const rows =
      status === "all"
        ? (this.db.query("SELECT id FROM wallet_deposits ORDER BY id DESC LIMIT ?").all(limit) as {
            id: number;
          }[])
        : (this.db
            .query("SELECT id FROM wallet_deposits WHERE status = ? ORDER BY id DESC LIMIT ?")
            .all(status, limit) as { id: number }[]);
    return rows.map((r) => this.getDeposit(r.id)!);
  }

  /**
   * Approve a pending deposit: credits the wallet exactly once (ledger UNIQUE
   * guard) inside one transaction. Returns the decision outcome.
   */
  approveDeposit(
    depositId: number,
    adminId: number,
  ):
    | { ok: true; deposit: WalletDeposit; credited: boolean; txId: number; balanceAfter: number }
    | { ok: false; error: string } {
    try {
      const result = tx(this.db, () => {
        const d = this.getDeposit(depositId);
        if (!d) return { ok: false as const, error: "درخواست یافت نشد" };
        if (d.status !== "pending") return { ok: false as const, error: "این درخواست قبلاً بررسی شده است" };
        const credit = this.applyLedger(d.telegramId, d.amount, "deposit", "deposit", d.id, {
          createdBy: adminId,
          note: `شارژ کیف پول (رسید ${d.receiptFileId ? "دارد" : "ندارد"})`,
        });
        this.db
          .query(
            "UPDATE wallet_deposits SET status = 'approved', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(adminId, nowIso(), nowIso(), depositId);
        return {
          ok: true as const,
          deposit: this.getDeposit(depositId)!,
          credited: credit.applied,
          txId: credit.tx.id,
          balanceAfter: credit.tx.balanceAfter,
        };
      });
      return result;
    } catch (err) {
      log.warn("deposit approve failed", { depositId, err: String(err) });
      return { ok: false, error: "تأیید انجام نشد؛ دوباره تلاش کنید" };
    }
  }

  rejectDeposit(depositId: number, adminId: number): { ok: true; deposit: WalletDeposit } | { ok: false; error: string } {
    const d = this.getDeposit(depositId);
    if (!d) return { ok: false, error: "درخواست یافت نشد" };
    if (d.status !== "pending") return { ok: false, error: "این درخواست قبلاً بررسی شده است" };
    const res = this.db
      .query(
        "UPDATE wallet_deposits SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(adminId, nowIso(), nowIso(), depositId);
    if (res.changes === 0) return { ok: false, error: "این درخواست قبلاً بررسی شده است" };
    return { ok: true, deposit: this.getDeposit(depositId)! };
  }

  // ---------- order payment integration ----------

  /**
   * Pay for an order from the wallet. Idempotent per orderId; concurrency-safe
   * via expectedBalance. Returns the ledger tx id for the order row.
   */
  payOrderFromWallet(
    telegramId: number,
    orderId: number,
    amount: number,
  ): { ok: true; txId: number } | { ok: false; error: string } {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const balance = this.getBalance(telegramId);
        if (balance < amount) return { ok: false, error: "موجودی کیف پول کافی نیست" };
        const r = this.applyLedger(telegramId, -amount, "order_payment", "order", orderId, {
          note: "پرداخت سفارش از کیف پول",
          expectedBalance: balance,
        });
        return { ok: true, txId: r.tx.id };
      } catch (err) {
        const msg = String((err as any)?.message ?? err);
        if (msg === "WALLET_CONCURRENCY") continue; // retry with fresh balance
        if (msg === "WALLET_INSUFFICIENT") return { ok: false, error: "موجودی کیف پول کافی نیست" };
        return { ok: false, error: "پرداخت از کیف پول انجام نشد" };
      }
    }
    return { ok: false, error: "پرداخت از کیف پول انجام نشد" };
  }

  /** Refund a wallet order payment (cancellation flow). Idempotent per order. */
  refundOrder(
    telegramId: number,
    orderId: number,
    amount: number,
    adminId: number | null,
  ): { ok: true; txId: number } | { ok: false; error: string } {
    try {
      const r = this.applyLedger(telegramId, amount, "refund", "order", orderId, {
        createdBy: adminId,
        note: "بازگشت وجه سفارش",
      });
      return { ok: true, txId: r.tx.id };
    } catch {
      return { ok: false, error: "بازگشت وجه انجام نشد" };
    }
  }

  /**
   * Manual admin adjustment of a customer's wallet (correction, promo credit,
   * comp, …). Idempotency is the caller's job here — unlike deposits/orders
   * there is no natural key, so each call is a distinct ledger entry.
   */
  adjustBalance(
    telegramId: number,
    amount: number,
    note: string | null,
    adminId: number,
  ): { ok: true; balance: number; txId: number } | { ok: false; error: string } {
    if (!Number.isInteger(amount) || amount === 0) {
      return { ok: false, error: "مبلغ باید عدد صحیح غیرصفر باشد" };
    }
    if (!this.getProfile(telegramId)) {
      return { ok: false, error: "مشتری یافت نشد" };
    }
    const cleanNote = note ? String(note).trim().slice(0, 200) || null : null;
    try {
      // No natural key for manual rows, so use a per-customer monotonic refId to
      // keep the ledger's UNIQUE(kind, ref_type, ref_id, telegram_id) satisfied.
      const seq = (
        this.db
          .query(
            "SELECT COALESCE(MAX(ref_id), 0) + 1 AS n FROM wallet_transactions WHERE telegram_id = ? AND kind = 'adjustment'",
          )
          .get(telegramId) as { n: number }
      ).n;
      const r = this.applyLedger(telegramId, amount, "adjustment", "order", seq, {
        createdBy: adminId,
        note: cleanNote,
      });
      if (!r.applied) return { ok: false, error: "این تراکنش قبلاً ثبت شده است" };
      return { ok: true, balance: r.tx.balanceAfter, txId: r.tx.id };
    } catch (err) {
      const msg = String((err as any)?.message ?? err);
      if (msg === "WALLET_INSUFFICIENT") return { ok: false, error: "موجودی کیف پول کافی نیست" };
      if (msg === "WALLET_LIMIT") return { ok: false, error: "موجودی کیف پول از حد مجاز بیشتر می‌شود" };
      return { ok: false, error: "ثبت تراکنش انجام نشد" };
    }
  }

  /**
   * Admin customer detail. Distinguishes order value from money actually paid:
   * paidTotal sums wallet-funded orders + card orders the admin marked paid.
   * Refunds are excluded from paidTotal (a refunded order is no longer "paid").
   */
  customerSummary(telegramId: number): {
    profile: CustomerProfile | null;
    balance: number;
    orderCount: number;
    orderValue: number;
    paidTotal: number;
    outstanding: number;
  } {
    const agg = this.db
      .query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS v FROM orders WHERE customer_telegram_id = ?`,
      )
      .get(telegramId) as { c: number; v: number };
    const paid = this.db
      .query(
        `SELECT COALESCE(SUM(total_amount), 0) AS p FROM orders
         WHERE customer_telegram_id = ? AND (payment_method = 'wallet' OR payment_status = 'paid')`,
      )
      .get(telegramId) as { p: number };
    // Refunds credited back reduce the net paid amount.
    const refunded = this.db
      .query(
        `SELECT COALESCE(SUM(amount), 0) AS r FROM wallet_transactions
         WHERE telegram_id = ? AND kind = 'refund'`,
      )
      .get(telegramId) as { r: number };
    const netPaid = Math.max(0, paid.p - refunded.r);
    return {
      profile: this.getProfile(telegramId),
      balance: this.getBalance(telegramId),
      orderCount: agg.c,
      orderValue: agg.v,
      paidTotal: netPaid,
      outstanding: Math.max(0, agg.v - netPaid),
    };
  }

  /**
   * Admin customer list, most recently active first. Merges three sources —
   * saved profiles, wallets, and order history — so a customer who ordered
   * without ever saving a profile still appears (nameless until they do).
   */
  listCustomerRows(limit = 100): {
    telegramId: number;
    fullName: string | null;
    phone: string | null;
    username: string | null;
    balance: number;
    orderCount: number;
    orderValue: number;
    lastActiveAt: string | null;
  }[] {
    const rows = this.db
      .query(
        `SELECT tg,
                MAX(full_name) AS full_name,
                MAX(phone) AS phone, MAX(username) AS username,
                MAX(balance) AS balance,
                MAX(cnt) AS order_count, MAX(val) AS order_value,
                MAX(last_at) AS last_at
         FROM (
           SELECT p.telegram_id AS tg,
                  TRIM(COALESCE(p.full_name, TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')))) AS full_name,
                  p.phone, p.username,
                  COALESCE(w.balance, 0) AS balance,
                  0 AS cnt, 0 AS val, p.created_at AS last_at
           FROM customer_profiles p
           LEFT JOIN wallets w ON w.telegram_id = p.telegram_id
           UNION ALL
           SELECT telegram_id, NULL, NULL, NULL, balance, 0, 0, updated_at
           FROM wallets
           UNION ALL
           SELECT customer_telegram_id, NULL, NULL, NULL, NULL,
                  COUNT(*), SUM(total_amount), MAX(created_at)
           FROM orders GROUP BY customer_telegram_id
         )
         GROUP BY tg
         ORDER BY last_at DESC
         LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      telegramId: r.tg,
      fullName: (r.full_name ?? "").trim() || null,
      phone: r.phone ?? null,
      username: r.username ?? null,
      balance: r.balance ?? 0,
      orderCount: r.order_count ?? 0,
      orderValue: r.order_value ?? 0,
      lastActiveAt: r.last_at ?? null,
    }));
  }
}
