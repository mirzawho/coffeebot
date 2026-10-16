import { InlineKeyboard } from "grammy";
import type { Category, Product } from "../services/menu";
import type { CartLine } from "../services/cart";
import type { TokenService } from "./tokens";

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
 *  co           start checkout
 *  skip         skip delivery notes
 *  cf:<tok>     final confirm
 *  cx           cancel checkout
 *  hlp          help
 */

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("☕ منوی محصولات", "cats")
    .text("🛒 سبد خرید", "cart")
    .row()
    .text("👤 پروفایل", "prof")
    .text("💰 کیف پول", "wal")
    .row()
    .text("📦 سفارش‌های من", "oh")
    .text("✅ تسویه حساب", "co")
    .row()
    .text("ℹ️ راهنما", "hlp");
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

export function productKeyboard(telegramId: number, product: Product, tokens: TokenService): InlineKeyboard {
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
  kb.text("⬅️ محصولات", `cat:${product.categoryId}`).text("🛒 سبد خرید", "cart");
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
  kb.text("↩️ لغو", "oc").text("🛒 سبد خرید", "cart");
  return kb;
}

export function cartKeyboard(telegramId: number, lines: CartLine[], tokens: TokenService): InlineKeyboard {
  tokens.invalidateForUser(telegramId);
  const kb = new InlineKeyboard();
  for (const l of lines) {
    const minusTok = tokens.mint(telegramId, `q:${l.cartItemId}:m`);
    const plusTok = tokens.mint(telegramId, `q:${l.cartItemId}:p`);
    const delTok = tokens.mint(telegramId, `r:${l.cartItemId}`);
    const label = l.variantName ? `${l.productName} (${l.variantName})` : l.productName;
    const shortLabel = label.length > 24 ? `${label.slice(0, 22)}…` : label;
    kb.text(`➖ ${shortLabel} ×${l.quantity}`, `q:${l.cartItemId}:m:${minusTok}`)
      .text("➕", `q:${l.cartItemId}:p:${plusTok}`)
      .text("🗑", `r:${l.cartItemId}:${delTok}`)
      .row();
  }
  if (lines.length > 0) {
    kb.text("🗑 خالی کردن سبد", "clr").row();
  }
  kb.text("✅ تسویه حساب", "co").row().text("🏠 منوی اصلی", "m");
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
  walletBalance?: number,
): InlineKeyboard {
  if (stage === "receipt") {
    return new InlineKeyboard().text("🛒 سبد خرید", "cart").text("❌ انصراف از خرید", "cx");
  }
  const tok = tokens.mint(telegramId, "cf");
  const kb = new InlineKeyboard().text("✅ تأیید و ثبت نهایی", `cf:${tok}`);
  // Offer wallet payment when the balance is enough to cover the order.
  if (walletBalance !== undefined && walletBalance > 0) {
    const wtok = tokens.mint(telegramId, "wp");
    kb.text(`💰 پرداخت از کیف پول`, `wp:${wtok}`);
  }
  kb.text("🛒 سبد خرید", "cart").row().text("❌ انصراف", "cx");
  return kb;
}

export function deliveryKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⏭ بدون اطلاعات تحویل", "skip").text("🛒 سبد خرید", "cart");
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
