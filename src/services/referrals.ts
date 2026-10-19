import { randomBytes } from "node:crypto";
import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";

/**
 * Referral attribution. Each customer owns exactly one short referral code
 * (stable for life) and can have at most one current referrer. This service is
 * the single place referral relationships are created, changed, or removed —
 * the bot (/start deep links + manual entry) and the admin API all go through
 * it so validation rules can never diverge.
 *
 * Referrals are attribution only: no rewards, commissions, or wallet effects.
 */

/** Unambiguous alphabet: no 0/O, 1/I, easy to read aloud and retype. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 12;
export const MAX_REFERRAL_PAGE = 50;

export type ReferralSource = "link" | "manual" | "admin";

export interface ReferralRelation {
  telegramId: number;
  referredBy: number;
  referralCodeUsed: string;
  source: ReferralSource;
  createdAt: string;
}

export interface ReferredCustomer {
  telegramId: number;
  fullName: string | null;
  username: string | null;
  referralCode: string | null;
  createdAt: string;
}

export interface ReferralEvent {
  id: number;
  telegramId: number;
  previousReferredBy: number | null;
  newReferredBy: number | null;
  action: "set" | "change" | "remove";
  actor: number | null;
  createdAt: string;
}

export type ReferralResult =
  | { ok: true; relation: ReferralRelation; already: boolean }
  | { ok: false; error: string; code: ReferralErrorCode };

export type ReferralErrorCode =
  | "invalid_code"
  | "not_found"
  | "self_referral"
  | "already_registered"
  | "unknown_customer"
  | "unknown_referrer";

/**
 * Normalize user-entered code input: trim, strip common decorations, convert
 * Persian/Arabic digits and lowercase to the canonical stored form.
 * Returns null when the input cannot be a valid code.
 */
export function normalizeCode(raw: unknown): string | null {
  let s = String(raw ?? "").trim();
  // Deep-link payloads and pasted text sometimes carry wrapping junk.
  s = s.replace(/^ref[_\-\s]+/i, "");
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  s = s.replace(/[۰-۹]/g, (d) => String(persian.indexOf(d)));
  s = s.replace(/[٠-٩]/g, (d) => String(arabic.indexOf(d)));
  s = s.replace(/[\s\-_.]/g, "").toUpperCase();
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return s;
}

/** Extract a referral code from a /start deep-link parameter (`ref_<code>`). */
export function parseStartParam(param: string | null | undefined): string | null {
  const p = String(param ?? "").trim();
  if (!p) return null;
  if (!/^ref[_]/i.test(p)) return null;
  return normalizeCode(p.slice(4));
}

/** Build the Telegram deep link for a code. Username comes from live bot info. */
export function referralDeepLink(botUsername: string, code: string): string | null {
  const u = String(botUsername ?? "").trim().replace(/^@/, "");
  if (!u || !/^[A-Za-z0-9_]{4,}$/.test(u)) return null;
  return `https://t.me/${u}?start=ref_${code}`;
}

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export class ReferralService {
  constructor(private readonly db: Db) {
    this.backfillMissingCodes();
  }

  // ---------- codes ----------

  /**
   * Assign a referral code to every existing customer that lacks one.
   * Idempotent and collision-safe; runs once at service construction so
   * existing installations are backfilled without a data migration.
   */
  backfillMissingCodes(): void {
    const missing = this.db
      .query("SELECT telegram_id FROM customer_profiles WHERE referral_code IS NULL")
      .all() as { telegram_id: number }[];
    if (missing.length === 0) return;
    for (const row of missing) this.ensureCode(row.telegram_id);
  }

  /**
   * Get-or-create the customer's code. Never regenerates an existing code.
   * Creates a minimal profile row when the customer is not in the table yet
   * (a /start deep link can arrive before any profile exists).
   */
  ensureCode(telegramId: number): string {
    const existing = this.db
      .query("SELECT referral_code FROM customer_profiles WHERE telegram_id = ?")
      .get(telegramId) as { referral_code: string | null } | null;
    if (existing?.referral_code) return existing.referral_code;

    const now = nowIso();
    if (!existing) {
      this.db
        .query(
          "INSERT INTO customer_profiles (telegram_id, first_name, created_at, updated_at) VALUES (?, '', ?, ?) ON CONFLICT(telegram_id) DO NOTHING",
        )
        .run(telegramId, now, now);
    }
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = randomCode();
      const res = this.db
        .query("UPDATE customer_profiles SET referral_code = ? WHERE telegram_id = ? AND referral_code IS NULL")
        .run(code, telegramId);
      if (res.changes > 0) return code;
      const again = this.db
        .query("SELECT referral_code FROM customer_profiles WHERE telegram_id = ?")
        .get(telegramId) as { referral_code: string | null } | null;
      if (again?.referral_code) return again.referral_code; // concurrent assign won
    }
    throw new Error("could not allocate a unique referral code");
  }

  getCode(telegramId: number): string | null {
    const row = this.db
      .query("SELECT referral_code FROM customer_profiles WHERE telegram_id = ?")
      .get(telegramId) as { referral_code: string | null } | null;
    return row?.referral_code ?? null;
  }

  /** Resolve a (normalized or raw) code to its owning customer id, or null. */
  lookup(code: string): number | null {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const row = this.db
      .query("SELECT telegram_id FROM customer_profiles WHERE referral_code = ?")
      .get(normalized) as { telegram_id: number } | null;
    return row?.telegram_id ?? null;
  }

  // ---------- current relationship ----------

  getReferrer(telegramId: number): ReferralRelation | null {
    const r = this.db.query("SELECT * FROM referrals WHERE telegram_id = ?").get(telegramId) as any;
    if (!r) return null;
    return {
      telegramId: r.telegram_id,
      referredBy: r.referred_by,
      referralCodeUsed: r.referral_code_used,
      source: r.source,
      createdAt: r.created_at,
    };
  }

  countReferred(telegramId: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS c FROM referrals WHERE referred_by = ?")
      .get(telegramId) as { c: number };
    return row.c;
  }

  /** Direct referrals only (one level), newest first. */
  listReferred(telegramId: number, limit = 20, offset = 0): ReferredCustomer[] {
    const capped = Math.min(Math.max(1, limit), MAX_REFERRAL_PAGE);
    const rows = this.db
      .query(
        `SELECT r.telegram_id, r.created_at, p.referral_code,
                TRIM(COALESCE(NULLIF(p.full_name, ''), p.first_name)) AS full_name,
                p.username
         FROM referrals r
         LEFT JOIN customer_profiles p ON p.telegram_id = r.telegram_id
         WHERE r.referred_by = ?
         ORDER BY r.created_at DESC, r.telegram_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(telegramId, capped, Math.max(0, offset)) as any[];
    return rows.map((r) => ({
      telegramId: r.telegram_id,
      fullName: (r.full_name ?? "").trim() || null,
      username: r.username ?? null,
      referralCode: r.referral_code ?? null,
      createdAt: r.created_at,
    }));
  }

  history(telegramId: number, limit = 20): ReferralEvent[] {
    const rows = this.db
      .query("SELECT * FROM referral_events WHERE telegram_id = ? ORDER BY id DESC LIMIT ?")
      .all(telegramId, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      telegramId: r.telegram_id,
      previousReferredBy: r.previous_referred_by ?? null,
      newReferredBy: r.new_referred_by ?? null,
      action: r.action,
      actor: r.actor ?? null,
      createdAt: r.created_at,
    }));
  }

  // ---------- mutations (single validated path) ----------

  /**
   * Register `customer` as referred by the owner of `code` (deep link or
   * manual entry — identical validation). Idempotent: a customer who already
   * has a referrer is never overwritten.
   */
  applyReferral(
    customerTelegramId: number,
    code: string,
    source: Extract<ReferralSource, "link" | "manual">,
  ): ReferralResult {
    const normalized = normalizeCode(code);
    if (!normalized) {
      return { ok: false, error: "کد معرف معتبر نیست", code: "invalid_code" };
    }
    const referrerId = this.lookup(normalized);
    if (referrerId === null) {
      return { ok: false, error: "کد معرف یافت نشد", code: "not_found" };
    }
    return this.assign(customerTelegramId, referrerId, normalized, source, null);
  }

  /** Admin: assign or change a referrer (may replace an existing one). */
  setReferrerByAdmin(
    customerTelegramId: number,
    referrerTelegramId: number,
    adminId: number,
  ): ReferralResult {
    if (!this.getProfileName(customerTelegramId) && !this.codeRow(customerTelegramId)) {
      return { ok: false, error: "مشتری یافت نشد", code: "unknown_customer" };
    }
    if (!this.codeRow(referrerTelegramId)) {
      return { ok: false, error: "معرف یافت نشد", code: "unknown_referrer" };
    }
    const referrerCode = this.ensureCode(referrerTelegramId);
    this.ensureCode(customerTelegramId);
    return this.assign(customerTelegramId, referrerTelegramId, referrerCode, "admin", adminId);
  }

  /** Admin: remove the current referrer. The customer's own code is untouched. */
  removeReferrer(
    customerTelegramId: number,
    adminId: number,
  ): { ok: true } | { ok: false; error: string; code: ReferralErrorCode } {
    return tx(this.db, () => {
      const current = this.getReferrer(customerTelegramId);
      if (!current) {
        return { ok: false as const, error: "این مشتری معرفی ثبت‌نشده دارد", code: "not_found" as const };
      }
      this.db.query("DELETE FROM referrals WHERE telegram_id = ?").run(customerTelegramId);
      this.recordEvent(customerTelegramId, current.referredBy, null, "remove", adminId);
      return { ok: true as const };
    });
  }

  /** Shared assignment core. Caller has already validated/normalized. */
  private assign(
    customerTelegramId: number,
    referrerTelegramId: number,
    referrerCode: string,
    source: ReferralSource,
    actor: number | null,
  ): ReferralResult {
    if (customerTelegramId === referrerTelegramId) {
      return { ok: false, error: "امکان ثبت معرف برای خودتان وجود ندارد", code: "self_referral" };
    }
    // Customer self-registration never overwrites; an admin explicitly may.
    const allowChange = source === "admin";
    return tx(this.db, () => {
      const current = this.getReferrer(customerTelegramId);
      if (current && !allowChange) {
        // Never overwrite — repeated /start or a second code is a no-op.
        return {
          ok: false as const,
          error:
            current.referredBy === referrerTelegramId
              ? "این کد معرف قبلاً برای شما ثبت شده است"
              : "شما قبلاً با کد معرف ثبت‌نام کرده‌اید و امکان تغییر آن نیست",
          code: "already_registered" as const,
        };
      }
      const now = nowIso();
      // FK targets must exist; ensureCode creates minimal rows when needed.
      this.ensureCode(customerTelegramId);
      this.ensureCode(referrerTelegramId);
      if (current && allowChange) {
        this.db
          .query("UPDATE referrals SET referred_by = ?, referral_code_used = ?, source = ?, created_at = ? WHERE telegram_id = ?")
          .run(referrerTelegramId, referrerCode, source, now, customerTelegramId);
        this.recordEvent(customerTelegramId, current.referredBy, referrerTelegramId, "change", actor);
        return { ok: true as const, relation: this.getReferrer(customerTelegramId)!, already: false };
      }
      this.db
        .query(
          `INSERT INTO referrals (telegram_id, referred_by, referral_code_used, source, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(customerTelegramId, referrerTelegramId, referrerCode, source, now);
      this.recordEvent(customerTelegramId, null, referrerTelegramId, source === "admin" ? "change" : "set", actor);
      const relation = this.getReferrer(customerTelegramId)!;
      return { ok: true as const, relation, already: false };
    });
  }

  private recordEvent(
    telegramId: number,
    previous: number | null,
    next: number | null,
    action: "set" | "change" | "remove",
    actor: number | null,
  ): void {
    this.db
      .query(
        `INSERT INTO referral_events (telegram_id, previous_referred_by, new_referred_by, action, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(telegramId, previous, next, action, actor, nowIso());
  }

  private codeRow(telegramId: number): boolean {
    const row = this.db
      .query("SELECT 1 AS x FROM customer_profiles WHERE telegram_id = ?")
      .get(telegramId) as { x: number } | null;
    return !!row;
  }

  private getProfileName(telegramId: number): string | null {
    const row = this.db
      .query(
        "SELECT TRIM(COALESCE(NULLIF(full_name, ''), first_name)) AS name FROM customer_profiles WHERE telegram_id = ?",
      )
      .get(telegramId) as { name: string | null } | null;
    return row?.name?.trim() || null;
  }
}
