import { InlineKeyboard } from "grammy";
import type { Category, Product } from "../services/menu";
import type { CartLine } from "../services/cart";
import type { TokenService } from "./tokens";
import { toPersianDigits } from "../utils/dates";

/**
 * Callback data conventions (keep under 64 bytes):
 *  m            main menu
 *  cats         category list
 *  cat:<id>     products in category
 *  p:<id>       product detail / variant picker
 *  a:<pid>:<vid>:<tok>   add to cart (vid=0 => no variant)
 *  aq:<pid>:<vid>:<qty>:<tok>  add from an AI offer card (explicit quantity)
 *  oc           cancel/decline an AI offer card (no state change)
 *  cart         cart view
 *  q:<id>:<d>:<tok>      quantity delta (d=p|m)
 *  r:<id>:<tok>          remove line
 *  clr          clear-cart confirmation prompt
 *  clry:<tok>   confirmed clear
 *  co           start checkout ("پرداخت و ثبت سفارش" — from the cart view)
 *  pm:w / pm:c  choose wallet / card-to-card payment
 *  skip         skip delivery notes
 *  cf:<tok>     final confirm
 *  cx           cancel checkout
 *  hlp          help
 */

/**
 * Main menu. The cart button is only rendered while the cart has items —
 * an empty cart offers nothing to open. Checkout is NOT offered here: the
 * customer opens the cart and pays from its own view.
 */
export function mainMenu(cartLineCount = 0): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text("☕ منوی محصولات", "cats");
  if (cartLineCount > 0) kb.text("🛒 سبد خرید", "cart");
  kb.row()
    .text("👤 پروفایل", "prof")
    .text("💰 کیف پول", "wal")
    .row()
    .text("📦 سفارش‌های من", "oh")
    .row()
    .text("ℹ️ راهنما", "hlp");
  return kb;
}

export function categoriesKeyboard(categories: Category[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of categories) {
    kb.text(c.name, `cat:${c.id}`).row();
  }
  kb.text("🏠 منوی اصلی", "m");
  return kb;
}

export function productsKeyboard(categoryId: number, products: Product[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of products) {
    kb.text(p.name, `p:${p.id}`).row();
  }
  kb.text("⬅️ دسته‌بندی‌ها", "cats").text("🏠 منوی اصلی", "m");
  return kb;
}

export function productKeyboard(
  telegramId: number,
  product: Product,
  tokens: TokenService,
  cartLineCount = 0,
): InlineKeyboard {
  // Fresh tokens for this render; invalidate older unused ones to keep callbacks short-lived.
  tokens.invalidateForUser(telegramId);
  const kb = new InlineKeyboard();
  const activeVariants = product.variants.filter((v) => v.active);
  if (activeVariants.length > 0) {
    for (const v of activeVariants) {
      const tok = tokens.mint(telegramId, `a:${product.id}:${v.id}`);
      kb.text(`➕ ${v.name}`, `a:${product.id}:${v.id}:${tok}`).row();
    }
  } else if (product.fixedPriceAmount !== null) {
    const tok = tokens.mint(telegramId, `a:${product.id}:0`);
    kb.text("➕ افزودن به سبد", `a:${product.id}:0:${tok}`).row();
  }
  kb.text("⬅️ محصولات", `cat:${product.categoryId}`);
  if (cartLineCount > 0) kb.text("🛒 سبد خرید", "cart");
  return kb;
}

/**
 * Confirmation card keyboard for a product identified in conversation.
 * The add button carries an explicit quantity and a one-shot token; pressing
 * «لغو」 (or doing nothing) leaves the cart untouched. Tokens here are NOT
 * invalidated globally so several offer cards can coexist.
 */
export function offerKeyboard(
  telegramId: number,
  product: Product,
  variantId: number | null,
  quantity: number,
  tokens: TokenService,
  alternatives: Product[] = [],
  cartLineCount = 0,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const activeVariants = product.variants.filter((v) => v.active);
  const orderable =
    product.active &&
    ((activeVariants.length > 0 && activeVariants.some((v) => v.id === variantId)) ||
      (activeVariants.length === 0 && product.fixedPriceAmount !== null));
  if (orderable) {
    const vid = variantId ?? 0;
    const tok = tokens.mint(telegramId, `aq:${product.id}:${vid}:${quantity}`);
    kb.text(
      quantity > 1 ? `➕ افزودن ${quantity} عدد به سبد` : "➕ افزودن به سبد خرید",
      `aq:${product.id}:${vid}:${quantity}:${tok}`,
    ).row();
  }
  for (const alt of alternatives.slice(0, 3)) {
    kb.text(`similar: ${alt.name}`, `p:${alt.id}`).row();
  }
  kb.text("↩️ لغو", "oc");
  if (cartLineCount > 0) kb.text("🛒 سبد خرید", "cart");
  return kb;
}

/**
 * Cart lines: four buttons per item — `2x نام محصول` (display; re-renders the
 * cart), −, +, delete. The quantity prefix makes the count scannable at a glance.
 */
export function cartKeyboard(telegramId: number, lines: CartLine[], tokens: TokenService): InlineKeyboard {
  tokens.invalidateForUser(telegramId);
  const kb = new InlineKeyboard();
  for (const l of lines) {
    const minusTok = tokens.mint(telegramId, `q:${l.cartItemId}:m`);
    const plusTok = tokens.mint(telegramId, `q:${l.cartItemId}:p`);
    const delTok = tokens.mint(telegramId, `r:${l.cartItemId}`);
    const label = l.variantName ? `${l.productName} (${l.variantName})` : l.productName;
    const shortLabel = label.length > 20 ? `${label.slice(0, 18)}…` : label;
    kb.text(`${toPersianDigits(String(l.quantity))}× ${shortLabel}`, "cart")
      .text("➖", `q:${l.cartItemId}:m:${minusTok}`)
      .text("➕", `q:${l.cartItemId}:p:${plusTok}`)
      .text("🗑", `r:${l.cartItemId}:${delTok}`)
      .row();
  }
  if (lines.length > 0) {
    kb.text("🗑 خالی کردن سبد", "clr").row();
  }
  kb.text("💳 پرداخت و ثبت سفارش", "co").row().text("🏠 منوی اصلی", "m");
  return kb;
}

export function clearConfirmKeyboard(telegramId: number, tokens: TokenService): InlineKeyboard {
  const tok = tokens.mint(telegramId, "clry");
  return new InlineKeyboard().text("بله، خالی شود", `clry:${tok}`).text("انصراف", "cart");
}

export function checkoutKeyboard(
  telegramId: number,
  stage: "receipt" | "confirm",
  tokens: TokenService,
): InlineKeyboard {
  if (stage === "receipt") {
    return new InlineKeyboard().text("🛒 سبد خرید", "cart").text("❌ انصراف از خرید", "cx");
  }
  const tok = tokens.mint(telegramId, "cf");
  return new InlineKeyboard()
    .text("✅ تأیید و ثبت نهایی", `cf:${tok}`)
    .row()
    .text("🛒 سبد خرید", "cart")
    .text("❌ انصراف", "cx");
}

/**
 * Payment-method picker shown right after «پرداخت و ثبت سفارش». Each button
 * appears only when that method is both enabled by the admin and actually usable
 * (wallet balance covers the order / a card number is configured). The server
 * revalidates everything on press.
 */
export function paymentMethodKeyboard(opts: {
  walletBalance: number;
  total: number;
  walletEnabled: boolean;
  cardEnabled: boolean;
}): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (opts.walletEnabled && opts.walletBalance >= opts.total) {
    kb.text("💰 پرداخت از کیف پول", "pm:w").row();
  }
  if (opts.cardEnabled) {
    kb.text("💳 کارت به کارت", "pm:c").row();
  }
  kb.text("🛒 سبد خرید", "cart").text("❌ انصراف", "cx");
  return kb;
}

/**
 * Copy-to-clipboard buttons (Telegram `copy_text`) for a card-to-card payment:
 * the exact amount and the card number, so the customer pastes them into the
 * banking app instead of retyping. Both share one row when both are present.
 */
export function cardCopyKeyboard(amount: number | null, cardNumber: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (amount !== null && amount > 0) kb.copyText("📋 کپی مبلغ", String(amount));
  if (cardNumber) kb.copyText("📋 کپی شماره کارت", cardNumber);
  return kb;
}

export function deliveryKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⏭ بدون یادداشت", "skip").text("🛒 سبد خرید", "cart");
}

/**
 * Profile-wizard controls. «بعدی» keeps the saved value for the current field
 * (only offered when one exists); «تأیید» saves what has been collected so far.
 */
export function profileWizardKeyboard(step: "name" | "phone" | "address", canSkip: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (canSkip) kb.text("⏭ بعدی", "pf:skip");
  if (step === "address") kb.text("✅ تأیید و ذخیره", "pf:ok");
  kb.row().text("❌ لغو", "pf:cancel");
  return kb;
}

/**
 * Fulfillment picker after payment: delivery (if the customer has an address)
 * or pickup. The delivery button is only rendered when an address exists —
 * the server revalidates on press anyway.
 */
export function fulfillmentKeyboard(hasAddress: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasAddress) kb.text("🛵 ارسال به آدرس من", "fm:d").row();
  kb.text("🏪 خودم می‌آم تحویل بگیرم", "fm:p").row();
  kb.text("❌ انصراف", "cx");
  return kb;
}

/** Wallet main view: deposit, history, back. */
export function walletKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ شارژ کیف پول", "wdep")
    .text("📜 تاریخچه", "whist")
    .row()
    .text("🏠 منوی اصلی", "m");
}

/** Rating scale 1–5 for a delivered order. */
export function ratingKeyboard(telegramId: number, orderId: number, tokens: TokenService): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let star = 1; star <= 5; star++) {
    const tok = tokens.mint(telegramId, `rate:${orderId}:${star}`);
    kb.text("★".repeat(star), `rate:${orderId}:${star}:${tok}`);
  }
  kb.row().text("⏭ بعداً", "noop");
  return kb;
}
