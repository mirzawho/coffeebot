import type { Db } from "../db/database";
import { isValidTime } from "../utils/dates";
import { parseAmountInput } from "../utils/money";

export interface PaymentSettings {
  cardNumber: string;
  cardholderName: string;
  currency: string;
}

export interface ReportSettings {
  enabled: boolean;
  time: string; // HH:MM
  sendEmpty: boolean;
  recipients: number[];
}

/** Delivery time used when the operator has never saved report settings. */
export const DEFAULT_REPORT_TIME = "07:30";

export interface AdminProfile {
  name: string;
  username: string | null;
}

export function getSetting(db: Db, key: string): string {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? "";
}

export function setSetting(db: Db, key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getPaymentSettings(db: Db): PaymentSettings {
  return {
    cardNumber: getSetting(db, "card_number"),
    cardholderName: getSetting(db, "cardholder_name"),
    currency: getSetting(db, "currency") || "تومان",
  };
}

export function updatePaymentSettings(
  db: Db,
  input: { cardNumber: string; cardholderName: string; currency: string },
): PaymentSettings {
  const cardNumber = String(input.cardNumber ?? "").trim();
  const cardholderName = String(input.cardholderName ?? "").trim();
  const currency = String(input.currency ?? "").trim();

  if (cardNumber.length > 32) throw new Error("شماره کارت بیش از حد مجاز طولانی است");
  if (cardNumber && !/^[0-9\s-]+$/.test(cardNumber)) {
    throw new Error("شماره کارت فقط می‌تواند شامل اعداد، فاصله و خط تیره باشد");
  }
  if (cardholderName.length > 100) throw new Error("نام دارنده کارت بیش از حد مجاز طولانی است");
  if (!currency || currency.length > 16) throw new Error("واحد پول نامعتبر است");

  setSetting(db, "card_number", cardNumber);
  setSetting(db, "cardholder_name", cardholderName);
  setSetting(db, "currency", currency);
  return { cardNumber, cardholderName, currency };
}

export function getReportSettings(db: Db): ReportSettings {
  const enabled = getSetting(db, "report_enabled") !== "0";
  const time = getSetting(db, "report_time") || DEFAULT_REPORT_TIME;
  const sendEmpty = getSetting(db, "report_send_empty") === "1";
  let recipients: number[] = [];
  try {
    const parsed = JSON.parse(getSetting(db, "report_recipients") || "[]");
    if (Array.isArray(parsed)) recipients = parsed.filter((n) => Number.isInteger(n));
  } catch {
    recipients = [];
  }
  return { enabled, time, sendEmpty, recipients };
}

export function updateReportSettings(
  db: Db,
  input: { enabled: boolean; time: string; sendEmpty: boolean; recipients: number[] },
  adminIds: Set<number>,
): ReportSettings {
  const time = String(input.time ?? "").trim();
  if (!isValidTime(time)) throw new Error("زمان گزارش نامعتبر است (فرمت HH:MM)");

  const recipients = [...new Set(input.recipients ?? [])];
  if (!Array.isArray(recipients) || recipients.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error("گیرندگان گزارش نامعتبر هستند");
  }
  for (const r of recipients) {
    if (!adminIds.has(r)) {
      throw new Error(`شناسه ${r} در لیست مدیران مجاز نیست`);
    }
  }

  setSetting(db, "report_enabled", input.enabled ? "1" : "0");
  setSetting(db, "report_time", time);
  setSetting(db, "report_send_empty", input.sendEmpty ? "1" : "0");
  setSetting(db, "report_recipients", JSON.stringify(recipients));
  return { enabled: !!input.enabled, time, sendEmpty: !!input.sendEmpty, recipients };
}

export function getCurrency(db: Db): string {
  return getPaymentSettings(db).currency;
}

// ---------------------------------------------------------------------------
// AI settings (persona/toggles) — persisted in the settings table.
// ---------------------------------------------------------------------------

export const DEFAULT_AI_PERSONA =
  "به فارسی محاوره‌ای، طبیعی و صمیمی پاسخ بده. پاسخ‌ها کوتاه و مفید باشد. " +
  "از ایموجی محصولات وقتی مناسب استفاده کن. برای محصول نامشخص یک سؤال کوتاه بپرس. " +
  "کل منو را تکرار نکن و هر پاسخ را به تبلیغ تبدیل نکن.";

export type ReplyLength = "concise" | "normal" | "detailed";

export interface AiSettings {
  enabled: boolean;
  persona: string;
  replyLength: ReplyLength;
  personalizeGreeting: boolean;
  suggestUsual: boolean;
  streaming: boolean;
}

export function getAiSettings(db: Db): AiSettings {
  const g = (key: string) => getSetting(db, key);
  const persona = g("ai_persona").trim() || DEFAULT_AI_PERSONA;
  const replyLengthRaw = g("ai_reply_length");
  const replyLength: ReplyLength =
    replyLengthRaw === "concise" || replyLengthRaw === "detailed" ? replyLengthRaw : "normal";
  return {
    enabled: g("ai_enabled") !== "0",
    persona,
    replyLength,
    personalizeGreeting: g("ai_personalize_greeting") !== "0",
    suggestUsual: g("ai_suggest_usual") !== "0",
    streaming: g("ai_streaming") !== "0",
  };
}

export function updateAiSettings(
  db: Db,
  input: Partial<{
    enabled: boolean;
    persona: string;
    replyLength: string;
    personalizeGreeting: boolean;
    suggestUsual: boolean;
    streaming: boolean;
  }>,
): AiSettings {
  if (input.persona !== undefined) {
    const p = String(input.persona ?? "").trim();
    if (p.length > 2000) throw new Error("متن شخصیت بیش از حد مجاز طولانی است");
    setSetting(db, "ai_persona", p); // empty => falls back to default on read
  }
  if (input.replyLength !== undefined) {
    if (!["concise", "normal", "detailed"].includes(input.replyLength)) {
      throw new Error("طول پاسخ نامعتبر است");
    }
    setSetting(db, "ai_reply_length", input.replyLength);
  }
  if (input.enabled !== undefined) setSetting(db, "ai_enabled", input.enabled ? "1" : "0");
  if (input.personalizeGreeting !== undefined)
    setSetting(db, "ai_personalize_greeting", input.personalizeGreeting ? "1" : "0");
  if (input.suggestUsual !== undefined)
    setSetting(db, "ai_suggest_usual", input.suggestUsual ? "1" : "0");
  if (input.streaming !== undefined) setSetting(db, "ai_streaming", input.streaming ? "1" : "0");
  return getAiSettings(db);
}

// ---------------------------------------------------------------------------
// Customer notification toggles
// ---------------------------------------------------------------------------

export interface NotificationSettings {
  notifyOrderConfirmed: boolean;
  askDeliveryRating: boolean;
}

export function getNotificationSettings(db: Db): NotificationSettings {
  return {
    notifyOrderConfirmed: getSetting(db, "notify_order_confirmed") !== "0", // default on
    askDeliveryRating: getSetting(db, "ask_delivery_rating") !== "0", // default on
  };
}

export function updateNotificationSettings(
  db: Db,
  input: Partial<NotificationSettings>,
): NotificationSettings {
  if (input.notifyOrderConfirmed !== undefined)
    setSetting(db, "notify_order_confirmed", input.notifyOrderConfirmed ? "1" : "0");
  if (input.askDeliveryRating !== undefined)
    setSetting(db, "ask_delivery_rating", input.askDeliveryRating ? "1" : "0");
  return getNotificationSettings(db);
}

/**
 * Admin display names, learned only from validated Telegram initData (each
 * admin's own authenticated Mini App session). Never from client-supplied
 * fields. Stored as JSON: { [id]: { name, username } }.
 */
export function getAdminProfiles(db: Db): Record<number, AdminProfile> {
  try {
    const parsed = JSON.parse(getSetting(db, "admin_profiles") || "{}");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* corrupt value -> treat as empty */
  }
  return {};
}

export function rememberAdminProfile(
  db: Db,
  user: { id: number; first_name: string; last_name?: string; username?: string },
): void {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (!name && !user.username) return;
  const profiles = getAdminProfiles(db);
  const prev = profiles[user.id];
  const next = { name: name || (user.username ? `@${user.username}` : ""), username: user.username ?? null };
  if (prev && prev.name === next.name && prev.username === next.username) return; // no-op write
  profiles[user.id] = next;
  setSetting(db, "admin_profiles", JSON.stringify(profiles));
}

/** Human label for an admin id; falls back to "مدیر N" (N = allowlist position). */
export function adminDisplayName(
  profiles: Record<number, AdminProfile>,
  id: number,
  position: number,
): string {
  // Persian digits in the fallback so the label matches the rest of the UI.
  const fallback = `مدیر ${String(position + 1).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])}`;
  return profiles[id]?.name || fallback;
}

export { parseAmountInput };
