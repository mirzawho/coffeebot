/** Human-readable order numbers: CN-YYYYMMDD-XXXX (4-digit daily sequence). */
export function formatOrderNumber(businessDate: string, seq: number): string {
  const compact = businessDate.replace(/-/g, "");
  return `CN-${compact}-${String(seq).padStart(4, "0")}`;
}

export const MAX_ITEM_QUANTITY = 20;
export const MAX_CART_ITEMS = 40;
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_DELIVERY_NOTES_LENGTH = 500;
export const MAX_AI_HISTORY_MESSAGES = 12;
export const MAX_AI_OFFERS = 3;
export const MAX_USER_MESSAGE_LENGTH = 2000;
