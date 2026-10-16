/**
 * Deterministic "who am I" answers from the actual Telegram sender metadata.
 * Never inferred from message text, chat id, history, or the language model.
 */

export interface SenderIdentity {
  id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  language_code?: string | null;
}

const PERSIAN_IDENTITY_PATTERNS = [
  /من\s*کی\s*هستم/i,
  /کی\s*هستم/i,
  /آیدی\s*تلگرام/i,
  /ایدی\s*تلگرام/i,
  /ایدی\s*من/i,
  /شناسه\s*تلگرام/i,
  /id\s*من/i,
  /یوزرنیم\s*من/i,
  /نام\s*کاربری\s*من/i,
  /اکانت\s*من/i,
];

const ENGLISH_IDENTITY_PATTERNS = [
  /what'?s\s+my\s+(telegram\s+)?(user\s*)?id/i,
  /what\s+is\s+my\s+(telegram\s+)?(user\s*)?id/i,
  /my\s+(telegram\s+)?(user\s*)?id\b/i,
  /what'?s\s+my\s+username/i,
  /what\s+is\s+my\s+username/i,
  /my\s+username/i,
  /who\s+am\s+i/i,
  /who\s+is\s+this\s+user/i,
];

const PERSIAN_CHAR_RE = /[؀-ۿ]/;

/** True when the message is asking about the sender's own Telegram identity. */
export function isIdentityQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 500) return false;
  return (
    PERSIAN_IDENTITY_PATTERNS.some((re) => re.test(t)) ||
    ENGLISH_IDENTITY_PATTERNS.some((re) => re.test(t))
  );
}

/**
 * Build the identity reply from the trusted sender object. Only fields the
 * current update actually contains are shown. Includes an illustrative
 * ADMIN_IDS hint (no real IDs, no permission changes).
 */
export function buildIdentityReply(sender: SenderIdentity, text: string): string {
  const persian = PERSIAN_CHAR_RE.test(text) || PERSIAN_IDENTITY_PATTERNS.some((re) => re.test(text));
  const username = sender.username ? `@${sender.username}` : null;
  const fullName = [sender.first_name, sender.last_name].filter(Boolean).join(" ");

  if (persian) {
    const lines: string[] = ["اطلاعات حساب تلگرام شما:"];
    lines.push(`شناسه عددی (Telegram ID): ${sender.id}`);
    if (username) lines.push(`نام کاربری: ${username}`);
    if (fullName) lines.push(`نام: ${fullName}`);
    if (sender.language_code) lines.push(`زبان: ${sender.language_code}`);
    if (!username && !fullName) {
      lines.push("نام کاربری و نام برای این حساب ثبت نشده است.");
    }
    lines.push("");
    lines.push("برای دسترسی مدیریتی، ادمین می‌تواند همین شناسه عددی را در تنظیمات اضافه کند (به‌صورت نمونه):");
    lines.push("ADMIN_IDS=123456789,987654321");
    lines.push("دیدن شناسه خودتان دسترسی مدیر ایجاد نمی‌کند.");
    return lines.join("\n");
  }

  const lines: string[] = ["Your Telegram account:"];
  lines.push(`Telegram ID: ${sender.id}`);
  if (username) lines.push(`Username: ${username}`);
  if (fullName) lines.push(`Name: ${fullName}`);
  if (sender.language_code) lines.push(`Language: ${sender.language_code}`);
  if (!username && !fullName) {
    lines.push("No username or name is set for this account.");
  }
  lines.push("");
  lines.push("An administrator can add this numeric ID to the allowlist, e.g.:");
  lines.push("ADMIN_IDS=123456789,987654321");
  lines.push("Seeing your own ID does not grant admin access.");
  return lines.join("\n");
}
