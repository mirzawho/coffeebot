import { MAX_RECEIPT_BYTES } from "../utils/ids";

/**
 * Receipt media validation. Telegram's optional metadata (mime_type,
 * file_size) must not be trusted as absent-equals-OK: a missing value fails
 * validation rather than skipping it.
 */

export const ACCEPTED_RECEIPT_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export interface ReceiptCandidate {
  kind: "photo" | "document";
  fileId: string;
  messageId: number;
  /** undefined = Telegram did not provide it */
  size?: number;
  /** undefined = Telegram did not provide it */
  mime?: string | null;
}

export type ReceiptValidation =
  | { ok: true; fileId: string; messageId: number }
  | { ok: false; error: string };

export function validateReceipt(m: ReceiptCandidate): ReceiptValidation {
  if (!m.fileId) {
    return { ok: false, error: "فایل رسید نامعتبر است. لطفاً عکس رسید را دوباره ارسال کنید." };
  }
  if (m.kind === "photo") {
    // Telegram photos are always JPEG; size must be known to enforce the cap.
    if (m.size === undefined || m.size === null) {
      return {
        ok: false,
        error: "حجم فایل رسید مشخص نیست. لطفاً عکس را به‌صورت «عکس» (نه فایل) ارسال کنید.",
      };
    }
    if (m.size > MAX_RECEIPT_BYTES) {
      return { ok: false, error: "حجم رسید بیش از حد مجاز است (حداکثر ۱۰ مگابایت)." };
    }
    return { ok: true, fileId: m.fileId, messageId: m.messageId };
  }

  // Document: MIME must be present and an accepted image type.
  if (!m.mime) {
    return {
      ok: false,
      error: "نوع فایل رسید مشخص نیست. فقط تصاویر jpg/png/webp ارسال کنید.",
    };
  }
  if (!ACCEPTED_RECEIPT_MIMES.has(m.mime)) {
    return { ok: false, error: "فقط تصاویر (jpg/png/webp) پذیرفته می‌شوند." };
  }
  if (m.size === undefined || m.size === null) {
    return {
      ok: false,
      error: "حجم فایل رسید مشخص نیست. لطفاً عکس رسید را به‌صورت عکس ارسال کنید.",
    };
  }
  if (m.size > MAX_RECEIPT_BYTES) {
    return { ok: false, error: "حجم رسید بیش از حد مجاز است (حداکثر ۱۰ مگابایت)." };
  }
  return { ok: true, fileId: m.fileId, messageId: m.messageId };
}
