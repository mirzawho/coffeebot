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
• از «سبد خرید» و سپس «پرداخت و ثبت سفارش» روش پرداخت را انتخاب کنید:
  💰 کیف پول — اگر موجودی کافی باشد، مبلغ بلافاصله کسر می‌شود.
  💳 کارت به کارت — مبلغ را کارت به کارت کنید و تصویر رسید را بفرستید؛
     پس از تأیید مدیر، پرداخت ثبت می‌شود.
• ساعات کاری را رعایت کنید؛ سفارش‌های خارج از ساعات کاری به اولین روز کاری بعدی منتقل می‌شوند.

پرداخت کارت به کارت توسط ربات تأیید نمی‌شود؛ رسید دریافت و برای بررسی به مدیر ارجاع می‌شود.`;

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

/** Escape dynamic text for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Checkout-start message (HTML parse mode): the order summary and the
 * payment-method choice in ONE message — previously two separate sends.
 * Dynamic segments (product names, currency) are HTML-escaped.
 */
export function checkoutStartText(
  lines: CartLine[],
  total: number,
  currency: string,
  walletBalance: number,
  opts: { walletEnabled: boolean; cardEnabled: boolean },
): string {
  const parts: string[] = ["🧾 <b>خلاصه سفارش</b>:"];
  for (const l of lines) {
    const name = l.variantName ? `${l.productName} (${l.variantName})` : l.productName;
    parts.push(
      `• ${escapeHtml(name)} — ${toPersianDigits(String(l.quantity))} × ${formatAmount(l.unitPrice)} = ${escapeHtml(formatMoney(l.lineTotal, currency))}`,
    );
  }
  parts.push("");
  parts.push(`💳 مبلغ قابل پرداخت: <b>${escapeHtml(formatMoney(total, currency))}</b>`);
  parts.push("");
  parts.push("روش پرداخت را انتخاب کنید:");
  if (opts.walletEnabled) {
    parts.push(`💰 موجودی کیف پول شما: ${escapeHtml(formatMoney(walletBalance, currency))}`);
  }
  if (opts.walletEnabled && walletBalance < total) {
    parts.push(
      opts.cardEnabled
        ? "موجودی کیف پول برای این سفارش کافی نیست؛ لطفاً کارت به کارت کنید یا کیف پول را شارژ کنید."
        : "موجودی کیف پول برای این سفارش کافی نیست؛ لطفاً کیف پول را شارژ کنید.",
    );
  }
  return parts.join("\n");
}

export function paymentText(payment: PaymentSettings, total: number): string {
  const parts: string[] = ["💳 لطفاً مبلغ زیر را کارت به کارت کنید و تصویر رسید را ارسال کنید:"];
  parts.push("");
  parts.push(`مبلغ: ${formatMoney(total, payment.currency)}`);
  if (payment.cardNumber) parts.push(`شماره کارت: ${payment.cardNumber}`);
  if (payment.cardholderName) parts.push(`به نام: ${payment.cardholderName}`);
  parts.push("");
  parts.push("⚠️ توجه: ربات پرداخت را تأیید نمی‌کند؛ رسید فقط دریافت و ثبت می‌شود.");
  parts.push("");
  parts.push("📤 پس از پرداخت، تصویر رسید (عکس یا فایل تصویری) را همین‌جا بفرستید.");
  return parts.join("\n");
}

/** Shown when the customer picks wallet payment, before final confirmation. */
export function walletPaymentSummaryText(
  total: number,
  currency: string,
  balance: number,
): string {
  return [
    "💰 پرداخت از کیف پول",
    "",
    `مبلغ سفارش: ${formatMoney(total, currency)}`,
    `موجودی فعلی: ${formatMoney(balance, currency)}`,
    `موجودی پس از پرداخت: ${formatMoney(balance - total, currency)}`,
    "",
    "برای کسر مبلغ از کیف پول، سفارش را تأیید کنید.",
  ].join("\n");
}

export const RECEIPT_PROMPT_TEXT =
  "📤 لطفاً تصویر رسید پرداخت (عکس یا فایل تصویری) را ارسال کنید.";

export const PAYMENT_CHOICE_PROMPT_TEXT =
  "💳 لطفاً یکی از روش‌های پرداخت زیر را انتخاب کنید.";

export const RECEIPT_WRONG_STATE_TEXT =
  "رسید شما قبلاً دریافت شده است؛ در این مرحله نیازی به ارسال دوباره نیست.";

export const UNSUPPORTED_TEXT =
  "فعلاً فقط پیام متنی رو می‌تونم پردازش کنم. لطفاً درخواستت رو به‌صورت متن بنویس. 😊";

export const DELIVERY_PROMPT_TEXT =
  "📦 در صورت تمایل یادداشت تحویل بنویسید (مثلاً طبقه، شرکت یا توضیح خاص).\nیا با دکمه زیر بدون یادداشت ادامه دهید.";

export const FULFILLMENT_PROMPT_TEXT =
  "🛵 سفارش را برایتان ارسال کنیم یا خودتان تحویل می‌گیرید؟";

export function fulfillmentPromptText(hasAddress: boolean, address: string | null): string {
  return hasAddress
    ? `${FULFILLMENT_PROMPT_TEXT}\n\n📍 آدرس ثبت‌شده شما: ${address}`
    : `${FULFILLMENT_PROMPT_TEXT}\n\n(آدرسی ثبت نکرده‌اید؛ برای ارسال، ابتدا پروفایل را کامل کنید.)`;
}

export const FULFILLMENT_TIME_PROMPT_TEXT =
  "⏰ چه زمانی تحویل بگیرید؟ (مثلاً «ساعت ۵ عصر» یا «الان»)\nیا «پیش‌فرض» بفرستید تا در اولین فرصت آماده شود.";

export function fulfillmentLabel(method: "delivery" | "pickup" | null): string {
  return method === "delivery" ? "ارسال 🛵" : "تحویل حضوری 🏪";
}

export function confirmSummaryText(
  lines: CartLine[],
  total: number,
  currency: string,
  deliveryNotes: string | null,
  fulfillment?: { method: "delivery" | "pickup" | null; time: string | null },
): string {
  const parts = [orderSummaryText(lines, total, currency)];
  if (fulfillment && fulfillment.method) {
    const timePart = fulfillment.time ? ` — ${fulfillment.time}` : "";
    parts.push(`\n🛵 روش تحویل: ${fulfillmentLabel(fulfillment.method)}${timePart}`);
  }
  if (deliveryNotes) parts.push(`\n📦 یادداشت: ${deliveryNotes}`);
  parts.push("");
  parts.push("آیا سفارش نهایی شود؟");
  return parts.join("\n");
}

export function orderConfirmedText(order: Order): string {
  const fulfill =
    order.fulfillmentMethod === "delivery"
      ? `روش تحویل: ارسال 🛵${order.deliveryTime ? ` — ${order.deliveryTime}` : ""}`
      : "روش تحویل: تحویل حضوری 🏪";
  if (order.paymentMethod === "wallet") {
    return [
      "✅ سفارش شما با موفقیت ثبت شد.",
      "",
      `شماره سفارش: ${order.orderNumber}`,
      `مبلغ: ${formatMoney(order.totalAmount, order.currency)}`,
      "روش پرداخت: کیف پول 💰 (پرداخت انجام شد)",
      fulfill,
      "",
      "سفارش شما در نوبت آماده‌سازی است.",
    ].join("\n");
  }
  return [
    "✅ سفارش شما با موفقیت ثبت شد.",
    "",
    `شماره سفارش: ${order.orderNumber}`,
    `مبلغ: ${formatMoney(order.totalAmount, order.currency)}`,
    "روش پرداخت: کارت به کارت 💳",
    fulfill,
    "",
    "وضعیت: رسید دریافت شده (در انتظار تأیید پرداخت توسط مدیر).",
    "پس از تأیید پرداخت، سفارش آماده‌سازی می‌شود.",
  ].join("\n");
}

export const STALE_TEXT = "این دکمه دیگر معتبر نیست. لطفاً دوباره از منو اقدام کنید.";
export const AI_FALLBACK_TEXT =
  "متوجه نشدم. می‌توانید از دکمه‌های منو استفاده کنید یا سفارش را ساده‌تر بنویسید.";
