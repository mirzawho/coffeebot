import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotApp } from "../context";
import {
  cardCopyKeyboard,
  cartKeyboard,
  categoriesKeyboard,
  checkoutKeyboard,
  clearConfirmKeyboard,
  fulfillmentKeyboard,
  mainMenu,
  paymentMethodKeyboard,
  productKeyboard,
  productsKeyboard,
} from "../keyboards";
import {
  cartText,
  checkoutStartText,
  confirmSummaryText,
  fulfillmentPromptText,
  FULFILLMENT_TIME_PROMPT_TEXT,
  HELP_TEXT,
  orderConfirmedText,
  orderSummaryText,
  paymentText,
  productDetailText,
  STALE_TEXT,
  walletPaymentSummaryText,
  WELCOME_TEXT,
} from "../format";
import { formatMoney, formatAmount } from "../../utils/money";
import { toPersianDigits } from "../../utils/dates";
import { MAX_ITEM_QUANTITY } from "../../utils/ids";
import { log } from "../../utils/logger";
import { cardToCardAvailable } from "../../services/settings";
import { walletKeyboard, ratingKeyboard } from "../keyboards";
import { NO_ORDERS_TEXT, customerOrderDetailText, FULFILLMENT_LABELS } from "../format";
import {
  profileWizardCancel,
  profileWizardConfirm,
  profileWizardSkip,
  startProfileWizard,
} from "../profile-wizard";

/** Show the main menu (edits when possible, otherwise sends). */
export async function showMainMenu(ctx: Context, app: BotApp, edit = false): Promise<void> {
  const userId = ctx.from!.id;
  const text = `${WELCOME_TEXT}\n\nساعات کاری: ${app.businessHours.isOpenAt(new Date()) ? "🟢 باز" : "🔴 بسته"} | بازگشایی: ${app.businessHours.nextOpeningLabel(new Date())}`;
  const kb = mainMenu(app.cart.lineCount(userId));
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* fall through to send */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

export async function showHelp(ctx: Context, app: BotApp, edit = false): Promise<void> {
  const kb = mainMenu(app.cart.lineCount(ctx.from!.id));
  if (edit) {
    try {
      await ctx.editMessageText(HELP_TEXT, { reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(HELP_TEXT, { reply_markup: kb });
}

async function showCategories(ctx: Context, app: BotApp, edit = false): Promise<void> {
  const categories = app.menu.listCategories(false);
  const text =
    categories.length === 0
      ? "فعلاً دسته‌بندی فعالی وجود ندارد."
      : "دسته‌بندی مورد نظر را انتخاب کنید:";
  const kb = categories.length > 0
    ? categoriesKeyboard(categories)
    : mainMenu(app.cart.lineCount(ctx.from!.id));
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* ignore stale edit */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

async function showCategory(ctx: Context, app: BotApp, categoryId: number, edit = true): Promise<void> {
  const products = app.menu.listProducts(categoryId, false);
  const cat = app.menu.listCategories(false).find((c) => c.id === categoryId);
  const text = products.length === 0
    ? "در این دسته‌بندی محصولی موجود نیست."
    : `محصولات «${cat?.name ?? "—"}»:`;
  const kb = products.length > 0 ? productsKeyboard(categoryId, products) : categoriesKeyboard(app.menu.listCategories(false));
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* ignore */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

async function showProduct(ctx: Context, app: BotApp, productId: number, edit = true): Promise<void> {
  const userId = ctx.from!.id;
  const product = app.menu.getProduct(productId, false);
  if (!product || !product.active) {
    await ctx.answerCallbackQuery({ text: "این محصول دیگر موجود نیست", show_alert: true });
    await showCategories(ctx, app, true);
    return;
  }
  const { payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;
  const text = productDetailText(product, currency);
  const kb = productKeyboard(userId, product, app.tokens, app.cart.lineCount(userId));
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* ignore */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

export async function showCart(ctx: Context, app: BotApp, edit = true): Promise<void> {
  const userId = ctx.from!.id;
  app.cart.pruneInvalidItems(userId);
  // After-hours-aware totals — the same prices checkout will charge.
  const { total, lines, payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;
  const text = cartText(lines, total, currency);
  const kb = lines.length > 0
    ? cartKeyboard(userId, lines, app.tokens)
    : mainMenu();
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* ignore */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

export async function startCheckoutFlow(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const cart = app.cart.getOrCreate(userId);
  if (cart.state !== "browsing") {
    // Resume an in-progress checkout instead of erroring.
    if (cart.state === "checkout_payment") {
      await sendPaymentChoice(ctx, app);
      return;
    }
    if (cart.state === "checkout_receipt") {
      await sendCardPaymentStage(ctx, app, true);
      return;
    }
    if (cart.state === "checkout_fulfillment") {
      await sendFulfillmentChoice(ctx, app);
      return;
    }
    if (cart.state === "checkout_confirm") {
      await sendConfirmStage(ctx, app);
      return;
    }
  }
  const result = app.orders.startCheckout(userId);
  if (!result.ok) {
    await ctx.reply(result.error, { reply_markup: mainMenu(app.cart.lineCount(userId)) });
    return;
  }
  // One message: order summary + payment-method choice (previously two).
  await sendPaymentChoice(ctx, app, result.lines, result.total);
}

/** Payment-method picker (wallet balance + card-to-card), merged with the summary. */
async function sendPaymentChoice(
  ctx: Context,
  app: BotApp,
  summaryLines?: Parameters<typeof checkoutStartText>[0],
  summaryTotal?: number,
): Promise<void> {
  const userId = ctx.from!.id;
  // After-hours-aware — matches what startCheckout/confirmOrder will charge.
  const { total, lines, payment } = app.orders.getPaymentInstructions(userId);
  const balance = app.customers.getBalance(userId);
  const cardEnabled = cardToCardAvailable(payment);
  const opts = {
    walletEnabled: payment.walletEnabled,
    cardEnabled,
  };
  const showLines = summaryLines ?? lines;
  const showTotal = summaryTotal ?? total;
  await ctx.reply(checkoutStartText(showLines, showTotal, payment.currency, balance, opts), {
    parse_mode: "HTML",
    reply_markup: paymentMethodKeyboard({
      walletBalance: balance,
      total: showTotal,
      ...opts,
    }),
  });
}

/**
 * Card-to-card stage: payment instructions + receipt request as ONE message,
 * with copy-to-clipboard buttons for the amount and the card number.
 */
async function sendCardPaymentStage(ctx: Context, app: BotApp, withSummary: boolean): Promise<void> {
  const userId = ctx.from!.id;
  const { total, lines, payment } = app.orders.getPaymentInstructions(userId);
  const text = withSummary
    ? `${orderSummaryText(lines, total, payment.currency)}\n\n${paymentText(payment, total)}`
    : paymentText(payment, total);
  const copyKb = cardCopyKeyboard(total, payment.cardNumber || null);
  copyKb
    .row()
    .text("🛒 سبد خرید", "cart")
    .text("❌ انصراف از خرید", "cx");
  await ctx.reply(text, { reply_markup: copyKb });
}

export async function sendConfirmStage(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const cart = app.cart.get(userId);
  // After-hours-aware totals — what confirmOrder will actually charge.
  const { total, lines, payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;
  const balance = app.customers.getBalance(userId);
  const summary = confirmSummaryText(lines, total, currency, cart?.deliveryNotes ?? null, {
    method: cart?.fulfillmentMethod ?? null,
    time: cart?.fulfillmentTime ?? null,
  });
  const walletLine = balance > 0 ? `\n\n💰 موجودی کیف پول: ${formatMoney(balance, currency)}` : "";
  await ctx.reply(summary + walletLine, {
    reply_markup: checkoutKeyboard(userId, "confirm", app.tokens),
  });
}

/** Delivery-vs-pickup question, shown after payment/receipt. */
export async function sendFulfillmentChoice(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const profile = app.customers.getProfile(userId);
  const hasAddress = !!profile?.address;
  await ctx.reply(fulfillmentPromptText(hasAddress, profile?.address ?? null), {
    reply_markup: fulfillmentKeyboard(hasAddress),
  });
}

/** Register all callback-query handlers. */
export function registerCallbackHandlers(bot: any, app: BotApp): void {
  bot.on("callback_query", async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !ctx.from) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const userId = ctx.from.id;
    try {
      await handleCallback(ctx, app, data);
    } catch (err) {
      log.error("callback handler error", { err: String(err), data });
      await ctx.answerCallbackQuery({ text: "خطایی رخ داد؛ دوباره تلاش کنید", show_alert: true }).catch(() => {});
    } finally {
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });
}

async function handleCallback(ctx: Context, app: BotApp, data: string): Promise<void> {
  const userId = ctx.from!.id;

  if (data === "m") return showMainMenu(ctx, app, true);
  if (data === "hlp") return showHelp(ctx, app, true);
  if (data === "cats") return showCategories(ctx, app, true);
  if (data === "cart") return showCart(ctx, app, true);

  if (data.startsWith("cat:")) {
    const id = Number(data.slice(4));
    if (!Number.isInteger(id)) return showCategories(ctx, app, true);
    return showCategory(ctx, app, id, true);
  }

  if (data.startsWith("p:")) {
    const id = Number(data.slice(2));
    if (!Number.isInteger(id)) return showCategories(ctx, app, true);
    return showProduct(ctx, app, id, true);
  }

  if (data.startsWith("a:")) {
    // a:<pid>:<vid>:<tok>
    const [, pidRaw, vidRaw, tok] = data.split(":");
    const productId = Number(pidRaw);
    const variantId = vidRaw === "0" ? null : Number(vidRaw);
    if (!Number.isInteger(productId) || !tok) {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    const expected = `a:${productId}:${variantId ?? 0}`;
    if (!app.tokens.consume(userId, tok, expected)) {
      await ctx.answerCallbackQuery({ text: "این عمل قبلاً انجام شد", show_alert: true });
      await showProduct(ctx, app, productId, false).catch(() => {});
      return;
    }
    const res = app.cart.addItem(userId, productId, Number.isInteger(variantId) ? variantId : null, 1);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: res.error, show_alert: true });
      return;
    }
    const { total, lines, payment } = app.orders.getPaymentInstructions(userId);
    const currency = payment.currency;
    await ctx.answerCallbackQuery({ text: "به سبد اضافه شد ✓" });
    await ctx.reply(`✅ به سبد اضافه شد.\n${cartText(lines, total, currency)}`, {
      reply_markup: lines.length > 0 ? cartKeyboard(userId, lines, app.tokens) : mainMenu(),
    });
    return;
  }

  if (data.startsWith("aq:")) {
    // aq:<pid>:<vid>:<qty>:<tok> — add from an AI offer confirmation card.
    const [, pidRaw, vidRaw, qtyRaw, tok] = data.split(":");
    const productId = Number(pidRaw);
    const variantId = vidRaw === "0" ? null : Number(vidRaw);
    const quantity = Number(qtyRaw);
    if (
      !Number.isInteger(productId) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_ITEM_QUANTITY ||
      !tok
    ) {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    const expected = `aq:${productId}:${variantId ?? 0}:${quantity}`;
    if (!app.tokens.consume(userId, tok, expected)) {
      await ctx.answerCallbackQuery({ text: "این عمل قبلاً انجام شد", show_alert: true });
      return;
    }
    // Backend revalidates product/variant availability and price regardless
    // of what the (possibly stale or manipulated) button claimed.
    const res = app.cart.addItem(userId, productId, variantId, quantity);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: res.error, show_alert: true });
      return;
    }
    const { total, lines, payment } = app.orders.getPaymentInstructions(userId);
    await ctx.answerCallbackQuery({ text: "به سبد اضافه شد ✓" });
    await ctx.reply(`✅ به سبد اضافه شد.\n${cartText(lines, total, payment.currency)}`, {
      reply_markup: lines.length > 0 ? cartKeyboard(userId, lines, app.tokens) : mainMenu(),
    });
    return;
  }

  if (data === "oc") {
    // Decline an AI offer card — no state change; just retire the message.
    try {
      await ctx.editMessageText("✅ لغو شد. اگر محصول دیگری خواستید بنویسید یا از منو انتخاب کنید.");
    } catch {
      /* message already edited or stale — nothing to update */
    }
    return;
  }

  if (data.startsWith("q:")) {
    // q:<itemId>:<d>:<tok>
    const [, idRaw, dir, tok] = data.split(":");
    const itemId = Number(idRaw);
    if (!Number.isInteger(itemId) || !tok || (dir !== "p" && dir !== "m")) {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    const expected = `q:${itemId}:${dir}`;
    if (!app.tokens.consume(userId, tok, expected)) {
      await ctx.answerCallbackQuery({ text: "این عمل قبلاً انجام شد", show_alert: true });
      return;
    }
    const res = app.cart.changeQty(userId, itemId, dir === "p" ? 1 : -1);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: res.error, show_alert: true });
      await showCart(ctx, app, true).catch(() => {});
      return;
    }
    await showCart(ctx, app, true).catch(async () => {
      await showCart(ctx, app, false);
    });
    return;
  }

  if (data.startsWith("r:")) {
    // r:<itemId>:<tok>
    const [, idRaw, tok] = data.split(":");
    const itemId = Number(idRaw);
    if (!Number.isInteger(itemId) || !tok) {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    if (!app.tokens.consume(userId, tok, `r:${itemId}`)) {
      await ctx.answerCallbackQuery({ text: "این عمل قبلاً انجام شد", show_alert: true });
      return;
    }
    const res = app.cart.removeItem(userId, itemId);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: res.error, show_alert: true });
    }
    await showCart(ctx, app, true).catch(async () => {
      await showCart(ctx, app, false);
    });
    return;
  }

  if (data === "clr") {
    const totals = app.cart.getTotals(userId);
    if (totals.lines.length === 0) {
      await showCart(ctx, app, true);
      return;
    }
    try {
      await ctx.editMessageText("آیا از خالی کردن سبد خرید مطمئن هستید؟", {
        reply_markup: clearConfirmKeyboard(userId, app.tokens),
      });
    } catch {
      await ctx.reply("آیا از خالی کردن سبد خرید مطمئن هستید؟", {
        reply_markup: clearConfirmKeyboard(userId, app.tokens),
      });
    }
    return;
  }

  if (data.startsWith("clry:")) {
    const tok = data.slice(5);
    if (!app.tokens.consume(userId, tok, "clry")) {
      await ctx.answerCallbackQuery({ text: "این عمل قبلاً انجام شد", show_alert: true });
      return;
    }
    app.cart.clear(userId);
    await showCart(ctx, app, true).catch(async () => {
      await ctx.reply("🛒 سبد خرید شما خالی شد.", { reply_markup: mainMenu() });
    });
    return;
  }

  if (data === "co") {
    await startCheckoutFlow(ctx, app);
    return;
  }

  if (data === "pm:w" || data === "pm:c") {
    // Payment-method choice. The server revalidates the balance / card config
    // and the current total, so a stale button can never lock in an old price.
    const method = data === "pm:w" ? "wallet" : "card_to_card";
    const res = app.orders.choosePaymentMethod(userId, method);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: res.error, show_alert: true });
      return;
    }
    if (method === "wallet") {
      // Wallet is charged at final confirm; first ask how the order is received.
      await ctx.reply(walletPaymentSummaryText(res.total, app.orders.getPaymentInstructions(userId).payment.currency, res.balance));
      await sendFulfillmentChoice(ctx, app);
      return;
    }
    await sendCardPaymentStage(ctx, app, false);
    return;
  }

  if (data === "fm:d" || data === "fm:p") {
    // Fulfillment choice: delivery (needs a saved address) or pickup. The
    // server revalidates the state; delivery without an address is refused.
    const method = data === "fm:d" ? "delivery" : "pickup";
    const cart = app.cart.get(userId);
    if (!cart || cart.state !== "checkout_fulfillment") {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    if (method === "delivery") {
      const profile = app.customers.getProfile(userId);
      if (!profile?.address) {
        await ctx.answerCallbackQuery({
          text: "ابتدا آدرس خود را در پروفایل ثبت کنید",
          show_alert: true,
        });
        return;
      }
    }
    app.cart.setFulfillmentMethod(userId, method);
    app.fulfillmentTimeFlow.expect(userId, "time");
    await ctx.reply(FULFILLMENT_TIME_PROMPT_TEXT);
    return;
  }

  if (data === "skip") {
    const cart = app.cart.get(userId);
    if (!cart || cart.state !== "checkout_confirm") {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    app.orders.setDeliveryNotes(userId, null);
    await sendConfirmStage(ctx, app);
    return;
  }

  if (data.startsWith("cf:")) {
    const tok = data.slice(3);
    if (!app.tokens.consume(userId, tok, "cf")) {
      await ctx.answerCallbackQuery({ text: "سفارش قبلاً ثبت شد", show_alert: true });
      return;
    }
    const cart = app.cart.get(userId);
    if (!cart || cart.state !== "checkout_confirm") {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    const name = ctx.from?.first_name ? `${ctx.from.first_name}${ctx.from.last_name ? " " + ctx.from.last_name : ""}` : null;
    // The payment method comes from the cart (chosen at the payment stage).
    const result = app.orders.confirmOrder(userId, name);
    if (!result.ok) {
      if (result.reason === "price_changed") {
        await ctx.reply(
          `⚠️ قیمت برخی اقلام تغییر کرده است.\nمبلغ جدید: ${formatMoney(result.total, app.orders.getPaymentInstructions(userId).payment.currency)}\n\nلطفاً دوباره تأیید کنید.`,
          { reply_markup: checkoutKeyboard(userId, "confirm", app.tokens) },
        );
        return;
      }
      await ctx.reply(result.reason === "empty" ? "سبد خرید شما خالی است." : result.error, {
        reply_markup: mainMenu(app.cart.lineCount(userId)),
      });
      return;
    }
    // Record the customer's Telegram identity so the admin panel can show a
    // name/username and link to their chat.
    if (ctx.from) {
      app.customers.recordSender(userId, {
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      });
    }
    const balance = app.customers.getBalance(userId);
    const currency = app.orders.getPaymentInstructions(userId).payment.currency;
    const walletLine =
      result.order.paymentMethod === "wallet"
        ? `\n\n💰 پرداخت از کیف پول انجام شد.\nموجودی باقی‌مانده: ${formatMoney(balance, currency)}`
        : "";
    await ctx.reply(orderConfirmedText(result.order) + walletLine, { reply_markup: mainMenu() });
    return;
  }

  if (data === "cx") {
    app.cart.resetCheckout(userId);
    await ctx.reply("عملیات خرید لغو شد.", { reply_markup: mainMenu(app.cart.lineCount(userId)) });
    return;
  }

  // ---- profile / wallet / order history / rating ----

  if (data === "prof") return showProfile(ctx, app);
  if (data === "profedit") return startProfileWizard(ctx, app);
  if (data === "pf:skip") return profileWizardSkip(ctx, app);
  if (data === "pf:ok") return profileWizardConfirm(ctx, app);
  if (data === "pf:cancel") return profileWizardCancel(ctx, app);
  if (data === "wal") return showWallet(ctx, app);
  if (data === "wdep") return startDeposit(ctx, app);
  if (data === "whist") return showWalletHistory(ctx, app);
  if (data === "oh") return showOrderHistory(ctx, app, 0);
  if (data.startsWith("ohp:")) return showOrderHistory(ctx, app, Number(data.slice(4)) || 0);
  if (data.startsWith("od:")) {
    // od:<orderId> — open one of the customer's own orders.
    const orderId = Number(data.slice(3));
    const order = Number.isInteger(orderId) ? app.orders.loadOrderForCustomer(orderId, userId) : null;
    if (!order) {
      await ctx.answerCallbackQuery({ text: "سفارش یافت نشد", show_alert: true });
      return;
    }
    await ctx.reply(customerOrderDetailText(order));
    return;
  }
  if (data.startsWith("rate:")) {
    // rate:<orderId>:<stars>:<tok>
    const [, idRaw, starRaw, tok] = data.split(":");
    const orderId = Number(idRaw);
    const stars = Number(starRaw);
    if (!Number.isInteger(orderId) || !Number.isInteger(stars) || !tok) {
      await ctx.answerCallbackQuery({ text: STALE_TEXT, show_alert: true });
      return;
    }
    if (!app.tokens.consume(userId, tok, `rate:${orderId}:${stars}`)) {
      await ctx.answerCallbackQuery({ text: "این امتیاز قبلاً ثبت شد", show_alert: true });
      return;
    }
    const order = app.orders.loadOrderForCustomer(orderId, userId);
    if (!order) {
      await ctx.answerCallbackQuery({ text: "سفارش یافت نشد", show_alert: true });
      return;
    }
    const r = app.loyalty.saveRating(orderId, userId, stars, null);
    if (!r.ok) {
      await ctx.answerCallbackQuery({ text: r.error, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "ممنون از امتیازتان! ⭐" });
    try {
      await ctx.editMessageText("✅ ممنون از بازخوردتان!");
    } catch {
      /* stale edit is fine */
    }
    return;
  }

  if (data === "noop") return;
}

// ---------------------------------------------------------------------------
// Profile / wallet / history views
// ---------------------------------------------------------------------------

async function showProfile(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const p = app.customers.getProfile(userId);
  const text = p
    ? [
        "👤 پروفایل شما:",
        `نام: ${p.fullName}`,
        p.phone ? `موبایل: ${toPersianDigits(p.phone)}` : "موبایل: — (تکمیل کنید)",
        p.address ? `آدرس: ${p.address}` : "آدرس: — (اختیاری)",
      ].join("\n")
    : "👤 هنوز پروفایلی نساخته‌اید.";
  await ctx.reply(text, {
    reply_markup: new InlineKeyboard().text("✏️ ویرایش پروفایل", "profedit").row().text("🏠 منوی اصلی", "m"),
  });
}

async function showWallet(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const balance = app.customers.getBalance(userId);
  const { payment } = app.orders.getPaymentInstructions(userId);
  await ctx.reply(
    `💰 کیف پول شما: ${formatMoney(balance, payment.currency)}`,
    { reply_markup: walletKeyboard() },
  );
}

async function showWalletHistory(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const txs = app.customers.listTransactions(userId, 15);
  const deposits = app.customers.listDeposits(userId, 5);
  const parts: string[] = ["📜 تاریخچه کیف پول:", ""];
  if (txs.length === 0 && deposits.length === 0) {
    parts.push("تراکنشی ثبت نشده است.");
  }
  for (const t of txs) {
    const sign = t.amount > 0 ? "+" : "−";
    parts.push(`• ${t.createdAt.slice(0, 10)} — ${sign}${formatAmount(Math.abs(t.amount))} (مانده: ${formatAmount(t.balanceAfter)})`);
  }
  const pending = deposits.filter((d) => d.status === "pending");
  if (pending.length > 0) {
    parts.push("");
    parts.push(`⏳ درخواست شارژ در انتظار تأیید: ${pending.map((d) => `#${d.id}`).join("، ")}`);
  }
  await ctx.reply(parts.join("\n"), { reply_markup: walletKeyboard() });
}

async function startDeposit(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const { payment } = app.orders.getPaymentInstructions(userId);
  // Top-ups are paid by card, so they follow the card-to-card switch.
  if (!cardToCardAvailable(payment)) {
    await ctx.reply(
      "شارژ کیف پول در حال حاضر غیرفعال است؛ برای هماهنگی با کافه تماس بگیرید.",
      { reply_markup: walletKeyboard() },
    );
    return;
  }
  app.depositFlow.expect(userId);
  const copyKb = cardCopyKeyboard(null, payment.cardNumber || null);
  copyKb.row().text("🏠 منوی اصلی", "m");
  await ctx.reply(
    [
      "💰 مبلغ شارژ را به تومان بفرستید (فقط عدد). مثلاً:",
      "۱۰۰۰۰۰",
      "",
      `پس از انتخاب مبلغ، کارت به کارت کنید:\nشماره کارت: ${payment.cardNumber}\nبه نام: ${payment.cardholderName || "—"}`,
    ].join("\n"),
    { reply_markup: copyKb },
  );
}

async function showOrderHistory(ctx: Context, app: BotApp, offset: number): Promise<void> {
  const userId = ctx.from!.id;
  const PAGE = 5;
  const orders = app.orders.listForCustomer(userId, PAGE + 1, offset);
  if (orders.length === 0 && offset === 0) {
    await ctx.reply(NO_ORDERS_TEXT, { reply_markup: mainMenu(app.cart.lineCount(userId)) });
    return;
  }
  const page = orders.slice(0, PAGE);
  const parts: string[] = ["📦 سفارش‌های اخیر شما:", ""];
  for (const o of page) {
    const status = FULFILLMENT_LABELS[o.fulfillmentStatus] ?? o.fulfillmentStatus;
    parts.push(`• ${o.orderNumber} — ${formatMoney(o.totalAmount, o.currency)} — ${status}`);
  }
  const kb = new InlineKeyboard();
  if (offset > 0) kb.text("➡️ جدیدترها", `ohp:${Math.max(0, offset - PAGE)}`);
  if (orders.length > PAGE) kb.text("⬅️ قدیمی‌ترها", `ohp:${offset + PAGE}`);
  kb.row().text("🏠 منوی اصلی", "m");
  await ctx.reply(parts.join("\n"), { reply_markup: kb });
}
