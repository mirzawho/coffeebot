/** Integer money helpers. Amounts are stored as integers in the currency's smallest unit. */

export function assertAmount(amount: unknown, label = "amount"): asserts amount is number {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${label}: must be a non-negative integer`);
  }
}

export function parseAmountInput(raw: unknown): number {
  const s = String(raw ?? "").trim().replace(/[,\s]/g, "");
  if (!/^\d+$/.test(s)) throw new Error("مبلغ باید عدد صحیح باشد");
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error("مبلغ نامعتبر است");
  return n;
}

/** Format integer amount with thousands separators: 125000 -> "125,000" */
export function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

export function formatMoney(amount: number, currency: string): string {
  return `${formatAmount(amount)} ${currency}`;
}
