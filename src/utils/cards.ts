/**
 * Iranian bank card number helpers. A card number is stored normalized:
 * ASCII digits only, exactly 16 characters, validated with the Luhn check.
 * Display is always masked — the full number never leaves the customer's own
 * edit flow.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export const MAX_CARD_LENGTH = 16;

/** Fold Persian/Arabic digits to ASCII and strip spaces/hyphens/dots. */
export function normalizeCardNumber(raw: unknown): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
  s = s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  s = s.replace(/[\s\-.,]/g, "");
  return s;
}

/** Luhn (mod 10) check used by Iranian card numbers. */
export function luhnCheck(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Validate + normalize a customer-entered card number.
 * Returns the 16-digit normalized number, or null when invalid.
 */
export function validateCardNumber(raw: unknown): string | null {
  const s = normalizeCardNumber(raw);
  if (!new RegExp(`^\\d{${MAX_CARD_LENGTH}}$`).test(s)) return null;
  if (!luhnCheck(s)) return null;
  return s;
}

/** Mask for display: "603799...1234" style → "**** **** **** 1234". */
export function maskCardNumber(cardNumber: string): string {
  const s = normalizeCardNumber(cardNumber);
  const last4 = s.slice(-4);
  return `**** **** **** ${last4}`;
}

/** Last four digits only (stored on the refund snapshot). */
export function cardLast4(cardNumber: string): string {
  return normalizeCardNumber(cardNumber).slice(-4);
}
