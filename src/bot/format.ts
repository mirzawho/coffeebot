import type { CartLine } from "../services/cart";
import type { PaymentSettings } from "../services/settings";
import type { Product, Variant } from "../services/menu";
import type { Order } from "../services/orders";
import { formatAmount, formatMoney } from "../utils/money";
import { toPersianDigits } from "../utils/dates";

export const WELCOME_TEXT = `سلام! 👋
به کافه خوش آمدید.

از منوی زیر می‌توانید محصولات را ببینید، سبد خرید بسازید و سفارش دهید.
همچنین می‌توانید سفارش را با متن ساده بنویسید؛ مثلاً:
«دو تا اسپرسو سینگل می‌خوام» / «سبدم رو نشون بده» / «سفارشم رو ثبت کن»`;

export const HELP_TEXT = `راهنما:

• از «منوی محصولات» دسته‌بندی‌ها و محصولات را ببینید.
• می‌توانید مثل یک مکالمه بنویسید؛ مثلاً:
  «یه اسپرسو سینگل می‌خوام» / «تعداد کاپوچینو رو دو تا کن» / «اسپرسو رو حذف کن»
  «قیمت کاپوچینو چنده؟» / «سفارشم کجاست؟»
• با دکمه‌های سبد خرید تعداد را تغییر دهید یا قلمی را حذف کنید.
• در «تسویه حساب» خلاصه سفارش را ببینید، رسید پرداخت را ارسال کنید و تأیید کنید.
• ساعات کاری را رعایت کنید؛ سفارش‌های خارج از ساعات کاری به اولین روز کاری بعدی منتقل می‌شوند.

پرداخت توسط ربات تأیید نمی‌شود؛ فقط رسید دریافت و ثبت می‌شود.`;

export function productDetailText(p: Product, currency: string): string {
  const parts: string[] = [];
  const badge = p.emoji ? `${p.emoji} ` : "";
  parts.push(`${badge}☕ ${p.name}`);
  if (p.description) parts.push(p.description);
  const activeVariants = p.variants.filter((v) => v.active);
  if (activeVariants.length > 0) {
    parts.push("");
    parts.push("اندازه‌ها:");
    for (const v of activeVariants) {
      parts.push(`• ${v.name} — ${formatMoney(v.priceAmount, currency)}`);
    }
  } else if (p.fixedPriceAmount !== null) {
    parts.push("");
    parts.push(`قیمت: ${formatMoney(p.fixedPriceAmount, currency)}`);
  }
  return parts.join("\n");
}

/**
 * Confirmation/price card for a product identified in conversation.
 * Availability comes from the backend — never from the model.
 */
export function productCardText(
  p: Product,
  variant: Variant | null,
  quantity: number,
  available: boolean,
  currency: string,
): string {
  const name = variant ? `${p.name} — ${variant.name}` : p.name;
  const badge = p.emoji ? `${p.emoji} ` : "";
  const parts: string[] = [`☕ ${badge}${name}`];
  if (p.description) parts.push(p.description);
  parts.push("");
  if (!available) {
    parts.push("❌ ناموجود");
    return parts.join("\n");
  }
  const price = variant ? variant.priceAmount : p.fixedPriceAmount;
  if (price !== null) parts.push(`قیمت: ${formatMoney(price, currency)}`);
  if (quantity > 1) parts.push(`تعداد: ${toPersianDigits(String(quantity))}`);
  return parts.join("\n");
}

const STATUS_LABELS: Record<string, string> = {
  receipt_received_unverified: "رسید دریافت شده — در انتظار تأیید پرداخت",
};

export const FULFILLMENT_LABELS: Record<string, string> = {
  pending: "در انتظار بررسی",
  confirmed: "تأیید شده ☑️",
  delivered: "تحویل داده شده ✅",
  cancelled: "لغو شده",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unverified: "پرداخت تأیید نشده",
  receipt_received: "رسید دریافت شده — در انتظار بررسی",
  paid: "پرداخت شده 💰",
  rejected: "پرداخت رد شده",
};

export const NO_ORDERS_TEXT = "هنوز سفارشی برای شما ثبت نشده است.";

export function orderStatusText(order: Order): string {
  const status = STATUS_LABELS[order.status] ?? order.status;
  return [
    "📦 آخرین سفارش شما:",
    `شماره سفارش: ${order.orderNumber}`,
    `تاریخ: ${order.businessDate}`,
    `مبلغ: ${formatMoney(order.totalAmount, order.currency)}`,
    `وضعیت: ${status}`,
  ].join("\n");
}

/** Full detail for one of the customer's own orders (history view). */
export function customerOrderDetailText(order: Order): string {
  const fulfill = FULFILLMENT_LABELS[order.fulfillmentStatus] ?? order.fulfillmentStatus;
  const pay = PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus;
  const method = order.paymentMethod === "wallet" ? "کیف پول 💰" : "کارت به کارت 💳";
  return [
    `🧾 سفارش ${order.orderNumber}`,
    `تاریخ: ${order.businessDate}`,
    "",
    ...order.items.map(
      (it) =>
        `• ${it.variantName ? `${it.productName} (${it.variantName})` : it.productName} — ${toPersianDigits(String(it.quantity))} × ${formatAmount(it.unitPrice)} = ${formatMoney(it.lineTotal, order.currency)}`,
    ),
    "",
    `جمع کل: ${formatMoney(order.totalAmount, order.currency)}`,
    `روش پرداخت: ${method}`,
    `وضعیت پرداخت: ${pay}`,
    `وضعیت سفارش: ${fulfill}`,
  ].join("\n");
}

export function cartText(lines: CartLine[], total: number, currency: string): string {
  if (lines.length === 0) {
    return "🛒 سبد خرید شما خالی است.\nاز «منوی محصولات» می‌توانید انتخاب کنید.";
  }
  const parts: string[] = ["🛒 سبد خرید شما:", ""];
  for (const l of lines) {
    const name = l.variantName ? `${l.productName} (${l.variantName})` : l.productName;
    parts.push(`• ${name}`);
    parts.push(`  ${toPersianDigits(String(l.quantity))} × ${formatAmount(l.unitPrice)} = ${formatMoney(l.lineTotal, currency)}`);
  }
  parts.push("");
  parts.push(`جمع کل: ${formatMoney(total, currency)}`);
  return parts.join("\n");
}

export function orderSummaryText(lines: CartLine[], total: number, currency: string): string {
  return [
    "🧾 خلاصه سفارش:",
    ...lines.map((l) => {
      const name = l.variantName ? `${l.productName} (${l.variantName})` : l.productName;
      return `• ${name} — ${toPersianDigits(String(l.quantity))} × ${formatAmount(l.unitPrice)} = ${formatMoney(l.lineTotal, currency)}`;
    }),
    "",
    `مبلغ قابل پرداخت: ${formatMoney(total, currency)}`,
  ].join("\n");
}

export function paymentText(payment: PaymentSettings, total: number): string {
  const parts: string[] = ["💳 لطفاً مبلغ زیر را کارت به کارت کنید و تصویر رسید را ارسال کنید:"];
  parts.push("");
  parts.push(`مبلغ: ${formatMoney(total, payment.currency)}`);
  if (payment.cardNumber) parts.push(`شماره کارت: ${payment.cardNumber}`);
  if (payment.cardholderName) parts.push(`به نام: ${payment.cardholderName}`);
  parts.push("");
  parts.push("⚠️ توجه: ربات پرداخت را تأیید نمی‌کند؛ رسید فقط دریافت و ثبت می‌شود.");
  return parts.join("\n");
}

export const RECEIPT_PROMPT_TEXT =
  "📤 لطفاً تصویر رسید پرداخت (عکس یا فایل تصویری) را ارسال کنید.";

export const RECEIPT_WRONG_STATE_TEXT =
  "رسید شما قبلاً دریافت شده است؛ در این مرحله نیازی به ارسال دوباره نیست.";

export const UNSUPPORTED_TEXT =
  "فعلاً فقط پیام متنی رو می‌تونم پردازش کنم. لطفاً درخواستت رو به‌صورت متن بنویس. 😊";

export const DELIVERY_PROMPT_TEXT =
  "📦 در صورت تمایل اطلاعات تحویل را بنویسید (مثلاً طبقه، شرکت، زمان تحویل یا یادداشت).\nیا با دکمه زیر بدون اطلاعات تحویل ادامه دهید.";

export function confirmSummaryText(
  lines: CartLine[],
  total: number,
  currency: string,
  deliveryNotes: string | null,
): string {
  const parts = [orderSummaryText(lines, total, currency)];
  if (deliveryNotes) parts.push(`\n📦 تحویل: ${deliveryNotes}`);
  parts.push("");
  parts.push("آیا سفارش نهایی شود؟");
  return parts.join("\n");
}

export function orderConfirmedText(order: Order): string {
  return [
    "✅ سفارش شما با موفقیت ثبت شد.",
    "",
    `شماره سفارش: ${order.orderNumber}`,
    `مبلغ: ${formatMoney(order.totalAmount, order.currency)}`,
    "",
    "وضعیت: رسید دریافت شده (تأیید پرداخت انجام نشده است).",
    "پس از بررسی، سفارش آماده‌سازی می‌شود.",
  ].join("\n");
}

export const STALE_TEXT = "این دکمه دیگر معتبر نیست. لطفاً دوباره از منو اقدام کنید.";
export const AI_FALLBACK_TEXT =
  "متوجه نشدم. می‌توانید از دکمه‌های منو استفاده کنید یا سفارش را ساده‌تر بنویسید.";
