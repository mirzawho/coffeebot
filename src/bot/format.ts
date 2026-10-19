import type { CartLine } from "../services/cart";
import type { PaymentSettings } from "../services/settings";
import type { Product, Variant } from "../services/menu";
import type { Order } from "../services/orders";
import { formatAmount, formatMoney } from "../utils/money";
import { toPersianDigits, zonedNow } from "../utils/dates";

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
     سفارش بلافاصله ثبت می‌شود و پس از تأیید مدیر، پرداخت قطعی می‌شود.
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
    parts.push(
      `• ${name} — ${toPersianDigits(String(l.quantity))} × ${formatAmount(l.unitPrice)} = ${formatMoney(l.lineTotal, currency)}`,
    );
  }
  parts.push("");
  parts.push(`💳 مبلغ قابل پرداخت: ${formatMoney(total, currency)}`);
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
    `💳 مبلغ قابل پرداخت: ${formatMoney(total, currency)}`,
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
  parts.push("📤 پس از پرداخت، تصویر رسید (عکس یا فایل تصویری) را همین‌جا بفرستید تا سفارش ثبت شود.");
  return parts.join("\n");
}

/** Wallet chosen: show the balance effect; the order is placed on the next step. */
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
    "روش تحویل و زمان را انتخاب کنید تا سفارش ثبت و مبلغ کسر شود.",
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

/** Labels for the quick-pick time buttons, resolved to a concrete clock time where useful. */
export type QuickTimeChoice = "now" | "5m" | "10m" | "1h" | "tomorrow";

export function quickFulfillmentTimeLabel(choice: QuickTimeChoice, now: Date, timeZone: string): string {
  if (choice === "now") return "همین الان";
  if (choice === "tomorrow") return "فردا";
  const minutes = choice === "5m" ? 5 : choice === "10m" ? 10 : 60;
  const target = new Date(now.getTime() + minutes * 60_000);
  return `ساعت ${toPersianDigits(zonedNow(target, timeZone).time)}`;
}

export function fulfillmentLabel(method: "delivery" | "pickup" | null): string {
  return method === "delivery" ? "ارسال 🛵" : "تحویل حضوری 🏪";
}

export function fulfillmentLine(method: "delivery" | "pickup", time: string | null): string {
  const timePart = time ? ` — ${time}` : "";
  return `🛵 روش تحویل: ${fulfillmentLabel(method)}${timePart}`;
}

export const RECEIPT_PLACED_LEAD_TEXT = "🎉 ممنون! رسید شما دریافت شد و سفارش ثبت شد.";
export const ORDER_PLACED_LEAD_TEXT = "🎉 سفارش شما ثبت شد!";
/** Refusal when an immediate-time slot (الان / +۵ / +۱۰ دقیقه) is picked while closed. */
export const CLOSED_IMMEDIATE_TIME_TEXT =
  "کافه در حال حاضر بسته است؛ سفارش شما برای بازگشایی بعدی ثبت می‌شود. لطفاً «فردا» را انتخاب کنید.";;

/**
 * The placed-order summary — sent once the order row exists and re-rendered
 * in place when the customer edits delivery via the buttons. Defaults
 * (pickup, now) are already stored; `awaitingFulfillment` adds the hint to
 * pick method/time with the keyboard.
 */
export function orderPlacedSummaryText(
  order: Order,
  opts: { lead?: string; awaitingFulfillment?: boolean; walletRemaining?: number } = {},
): string {
  const parts: string[] = [opts.lead ?? ORDER_PLACED_LEAD_TEXT];
  parts.push("");
  parts.push(`شماره سفارش: ${order.orderNumber}`);
  for (const it of order.items) {
    const name = it.variantName ? `${it.productName} (${it.variantName})` : it.productName;
    parts.push(
      `• ${name} — ${toPersianDigits(String(it.quantity))} × ${formatAmount(it.unitPrice)} = ${formatMoney(it.lineTotal, order.currency)}`,
    );
  }
  parts.push("");
  parts.push(`مبلغ کل: ${formatMoney(order.totalAmount, order.currency)}`);
  parts.push("");
  parts.push(fulfillmentLine(order.fulfillmentMethod, order.deliveryTime));
  parts.push("");
  if (order.paymentMethod === "wallet") {
    const remaining =
      opts.walletRemaining !== undefined
        ? ` — موجودی باقی‌مانده: ${formatMoney(opts.walletRemaining, order.currency)}`
        : "";
    parts.push(`💰 پرداخت از کیف پول انجام شد${remaining}.`);
  } else {
    parts.push("💳 وضعیت پرداخت: رسید دریافت شده — در انتظار تأیید مدیر.");
  }
  if (opts.awaitingFulfillment) {
    parts.push("");
    parts.push("روش تحویل و زمان را با دکمه‌های زیر انتخاب کنید (پیش‌فرض: تحویل حضوری — الان).");
  }
  return parts.join("\n");
}

/** Shown when the price drifted before the order could be placed. */
export function priceChangedText(total: number, currency: string): string {
  return [
    "⚠️ قیمت برخی اقلام تغییر کرده است.",
    `مبلغ جدید: ${formatMoney(total, currency)}`,
    "",
    "دکمه‌های زیر را بزنید تا سفارش با مبلغ جدید ثبت شود.",
  ].join("\n");
}

/** Admin pressed لغو on a receipt: ask for the rejection reason. */
export const REJECT_REASON_PROMPT_TEXT =
  "📝 دلیل رد رسید را بنویسید (مثلاً: مبلغ واریزی کمتر از مبلغ سفارش است).\nاین متن به‌همراه تصویر رسید برای مشتری ارسال می‌شود.";

/** Customer-facing rejection notice; sent together with the receipt image. */
export function paymentRejectedCustomerText(orderNumber: string, reason: string): string {
  return [
    `⚠️ رسید پرداخت سفارش ${orderNumber} تأیید نشد.`,
    "",
    `دلیل: ${reason}`,
    "",
    "لطفاً با کافه تماس بگیرید.",
  ].join("\n");
}

/**
 * Captions for the admin receipt photo message (scheduler-sent). The pending
 * caption is written once at send time; approved/rejected replace it after a
 * review decision so the Telegram message, the database, and the panel agree.
 */
export const receiptPendingCaption = (orderNumber: string): string =>
  `رسید سفارش ${orderNumber} (تأییدنشده)`;
export const receiptApprovedCaption = (orderNumber: string): string =>
  `رسید سفارش ${orderNumber} (تأییدشده ✓)`;
export const receiptRejectedCaption = (orderNumber: string): string =>
  `رسید سفارش ${orderNumber} (رد شده)`;

export const STALE_TEXT = "این دکمه دیگر معتبر نیست. لطفاً دوباره از منو اقدام کنید.";
export const AI_FALLBACK_TEXT =
  "متوجه نشدم. می‌توانید از دکمه‌های منو استفاده کنید یا سفارش را ساده‌تر بنویسید.";

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export const REFERRAL_CODE_PROMPT_TEXT = `لطفاً کد معرف را به صورت متن ارسال کنید.

نمونه: ABCD2345

برای انصراف، دکمه «انصراف» را بزنید یا /cancel را بفرستید.`;

export const REFERRAL_CANCELLED_TEXT = "ثبت کد معرف لغو شد.";
export const REFERRAL_INVALID_TEXT =
  "کد معرف معتبر نیست. کد باید ۸ کاراکتر باشد (مثلاً ABCD2345). دوباره تلاش کنید یا انصراف دهید.";
export const REFERRAL_NOT_FOUND_TEXT =
  "این کد معرف یافت نشد. لطفاً کد را بررسی و دوباره وارد کنید یا انصراف دهید.";
export const REFERRAL_SELF_TEXT =
  "امکان ثبت کد معرف خودتان وجود ندارد. کد دیگری وارد کنید یا انصراف دهید.";
export const REFERRAL_ALREADY_TEXT =
  "شما قبلاً با کد معرف ثبت‌نام کرده‌اید و امکان تغییر آن نیست.";

export function referralSuccessText(referrerName: string | null): string {
  const who = referrerName ? ` (${referrerName})` : "";
  return `✅ کد معرف با موفقیت ثبت شد${who}.\nاز این پس شما زیرمجموعه این معرف هستید.`;
}

export function referralSectionText(
  code: string,
  referredCount: number,
  botUsername: string | null,
): string {
  const link = botUsername ? `https://t.me/${botUsername}?start=ref_${code}` : null;
  return [
    "👥 دعوت از دوستان",
    "",
    `کد معرف شما: ${code}`,
    "",
    link ? `لینک دعوت:\n${link}` : null,
    "",
    `تعداد مشتریانی که با کد شما ثبت‌نام کرده‌اند: ${referredCount}`,
    "",
    "دوستان می‌توانند لینک دعوت شما را باز کنند و ثبت‌نام کنند،",
    "یا پس از شروع گفتگو با ربات، کد معرف شما را در بخش",
    "«استفاده از کد معرف» وارد کنند.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function referralAppliedOnStartText(referrerName: string | null): string {
  const who = referrerName ? ` (${referrerName})` : "";
  return `✅ کد معرف شما${who} ثبت شد.`;
}
