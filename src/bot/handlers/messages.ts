import type { Context } from "grammy";
import type { BotApp } from "../context";
import { pushHistory } from "../context";
import {
  cardCopyKeyboard,
  cartKeyboard,
  clearConfirmKeyboard,
  mainMenu,
  offerKeyboard,
  paymentMethodKeyboard,
  placedFulfillmentKeyboard,
  receiptKeyboard,
  referralEntryKeyboard,
} from "../keyboards";
import {
  AI_FALLBACK_TEXT,
  cartText,
  CLOSED_IMMEDIATE_TIME_TEXT,
  HELP_TEXT,
  NO_ORDERS_TEXT,
  ORDER_PLACED_LEAD_TEXT,
  orderPlacedSummaryText,
  orderStatusText,
  PAYMENT_CHOICE_PROMPT_TEXT,
  paymentRejectedCustomerText,
  priceChangedText,
  productCardText,
  quickFulfillmentTimeLabel,
  RECEIPT_PLACED_LEAD_TEXT,
  RECEIPT_PROMPT_TEXT,
  RECEIPT_WRONG_STATE_TEXT,
  REFERRAL_ALREADY_TEXT,
  REFERRAL_CANCELLED_TEXT,
  REFERRAL_CODE_PROMPT_TEXT,
  REFERRAL_INVALID_TEXT,
  REFERRAL_NOT_FOUND_TEXT,
  REFERRAL_SELF_TEXT,
  referralAppliedOnStartText,
  referralSuccessText,
  UNSUPPORTED_TEXT,
  walletPaymentSummaryText,
  WELCOME_TEXT,
  type QuickTimeChoice,
} from "../format";
import { MAX_AI_OFFERS, MAX_ITEM_QUANTITY, MAX_USER_MESSAGE_LENGTH } from "../../utils/ids";
import { FALLBACK_REPLY, type AiResult } from "../../services/ollama";
import { cardToCardAvailable, getAiSettings } from "../../services/settings";
import { handleProfileWizardText, startProfileWizard } from "../profile-wizard";
import { handleCardWizardText } from "../card-wizard";
import { validateReceipt } from "../receipt";
import { isIdentityQuestion, buildIdentityReply } from "../identity";
import { log } from "../../utils/logger";
import { finalizeOrder, showHelp, showMainMenu, showCart, startCheckoutFlow } from "./callbacks";
import { withTypingIndicator } from "../typing";
import { walletKeyboard } from "../keyboards";
import { membershipJoinUrl } from "../guards/channel-membership";
import { parseStartParam } from "../../services/referrals";
import { formatMoney } from "../../utils/money";
import { toPersianDigits } from "../../utils/dates";

/**
 * Main menu for a user, built from their PERSISTED referral status: the
 * «استفاده از کد معرف» entry disappears once the customer has a referrer.
 */
export function menuFor(
  app: BotApp,
  userId: number,
  joinChannelUrl: string | null = null,
) {
  const showReferralEntry = app.referrals.getReferrer(userId) === null;
  return mainMenu(app.cart.lineCount(userId), joinChannelUrl, showReferralEntry);
}

/** Register /start, /help, text (AI + delivery notes) and photo/document handlers. */
export function registerMessageHandlers(bot: any, app: BotApp): void {
  bot.command("start", async (ctx: Context) => {
    const userId = ctx.from!.id;
    app.cart.getOrCreate(userId);

    // Deep-link referral (`https://t.me/<bot>?start=ref_<code>`). Registered
    // BEFORE the menu is rendered so the keyboard reflects the new state.
    // Every failure mode falls through to the normal flow untouched.
    const startParam = (ctx as any).startParam as string | undefined;
    const refCode = parseStartParam(startParam);
    if (refCode) {
      // A brand-new customer may have no profile row yet; applyReferral
      // creates the customer record and then the relationship, in that order.
      const result = app.referrals.applyReferral(userId, refCode, "link");
      if (result.ok) {
        const referrerName = app.customers.getProfile(result.relation.referredBy)?.fullName || null;
        await ctx.reply(referralAppliedOnStartText(referrerName));
      } else if (result.code === "already_registered") {
        // Graceful: a repeated /start never overwrites the original referrer.
        await ctx.reply(REFERRAL_ALREADY_TEXT);
      }
      // invalid/not-found/self: silent skip — the normal flow continues.
    }

    const joinUrl = await membershipJoinUrl(app, userId);
    await ctx.reply(WELCOME_TEXT, { reply_markup: menuFor(app, userId, joinUrl) });
    // First run: a customer without a saved profile is walked through it once.
    if (!app.customers.isProfileComplete(userId)) {
      await startProfileWizard(ctx, app);
    }
  });

  bot.command("help", async (ctx: Context) => {
    await ctx.reply(HELP_TEXT, { reply_markup: menuFor(app, ctx.from!.id) });
  });

  // Deterministic identity command — answered from the trusted sender object.
  // Persian is the app default, so the command replies in Persian.
  bot.command("whoami", async (ctx: Context) => {
    await ctx.reply(buildIdentityReply(senderIdentity(ctx), "من کی هستم"));
  });

  bot.on("message:photo", async (ctx: Context) => {
    await handleReceiptMedia(ctx, app, "photo");
  });

  bot.on("message:document", async (ctx: Context) => {
    await handleReceiptMedia(ctx, app, "document");
  });

  bot.on("message:text", async (ctx: Context) => {
    const raw = ctx.message?.text;
    if (typeof raw !== "string") return;
    const text = raw.trim();
    // Commands are handled by their registered command handlers, except
    // /cancel which handleText owns (it must also abort active capture flows).
    if (text === "/start" || text === "/help" || text === "/whoami" || text === "/admin") return;
    await handleText(ctx, app, text);
  });

  // Generic fallback for unsupported message types (voice, sticker, video,
  // contact, location, ...). Runs last; text/photo/document are handled above
  // so this only fires for content the app does not process.
  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg) return;
    if (msg.text || msg.photo || msg.document) return; // handled by dedicated flows
    await ctx.reply(UNSUPPORTED_TEXT);
  });
}

/** Trusted sender metadata for the current update (never from message text). */
function senderIdentity(ctx: Context) {
  return {
    id: ctx.from!.id,
    username: ctx.from!.username ?? null,
    first_name: ctx.from!.first_name ?? null,
    last_name: ctx.from!.last_name ?? null,
    language_code: ctx.from!.language_code ?? null,
  };
}

async function handleText(ctx: Context, app: BotApp, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const cart = app.cart.getOrCreate(userId);

  // /cancel aborts any active capture flow and resets an in-progress checkout.
  // It is handled here (not only as a command) because the text handler runs
  // first and would otherwise swallow the command.
  if (text === "/cancel") {
    const wasActive =
      app.profileEdit.isActive(userId) ||
      app.depositFlow.isActive(userId) ||
      app.rejectReasonFlow.isActive(userId) ||
      app.referralFlow.isActive(userId) ||
      app.cardEdit.isActive(userId);
    app.profileEdit.clear(userId);
    app.depositFlow.clear(userId);
    app.rejectReasonFlow.clear(userId);
    app.referralFlow.clear(userId);
    app.cardEdit.clear(userId);
    if (wasActive) {
      await ctx.reply("عملیات لغو شد.", { reply_markup: menuFor(app, userId) });
      return;
    }
    app.cart.resetCheckout(userId);
    await ctx.reply("عملیات لغو شد.", { reply_markup: menuFor(app, userId) });
    return;
  }

  // Admin's rejection reason: captured before every other flow so an admin's
  // text is never consumed by AI/checkout state while they're mid-review.
  if (app.rejectReasonFlow.isActive(userId)) {
    const orderId = Number(app.rejectReasonFlow.step(userId));
    app.rejectReasonFlow.clear(userId);
    await applyRejectReason(ctx, app, Number.isInteger(orderId) ? orderId : null, text);
    return;
  }

  // Active text-capture flows take precedence (profile wizard, deposit amount).
  // The step is read before clearing so multi-field wizards know which question
  // was last asked.
  if (app.profileEdit.isActive(userId)) {
    const step = app.profileEdit.step(userId);
    app.profileEdit.clear(userId);
    await applyProfileEdit(ctx, app, text, step);
    return;
  }
  if (app.depositFlow.isActive(userId)) {
    app.depositFlow.clear(userId);
    await applyDepositAmount(ctx, app, text);
    return;
  }
  // Referral code entry — must never fall through to the AI ordering path.
  if (app.referralFlow.isActive(userId)) {
    app.referralFlow.clear(userId);
    await applyReferralCode(ctx, app, text);
    return;
  }
  // Bank-card number entry — validated by saveCard; never reaches the AI.
  if (app.cardEdit.isActive(userId)) {
    const step = app.cardEdit.step(userId);
    app.cardEdit.clear(userId);
    await handleCardWizardText(ctx, app, text, step);
    return;
  }

  // Deterministic identity questions — answered from the trusted sender
  // object of the current update, never from the AI or message content.
  if (isIdentityQuestion(text)) {
    await ctx.reply(buildIdentityReply(senderIdentity(ctx), text));
    return;
  }

  // Checkout states take precedence over AI.
  if (cart.state === "checkout_payment") {
    const { payment, total } = app.orders.getPaymentInstructions(userId);
    await ctx.reply(PAYMENT_CHOICE_PROMPT_TEXT, {
      reply_markup: paymentMethodKeyboard({
        walletBalance: app.customers.getBalance(userId),
        total,
        walletEnabled: payment.walletEnabled,
        cardEnabled: cardToCardAvailable(payment),
      }),
    });
    return;
  }

  if (cart.state === "checkout_receipt") {
    await ctx.reply(RECEIPT_PROMPT_TEXT, { reply_markup: receiptKeyboard() });
    return;
  }

  if (cart.state === "checkout_fulfillment" || cart.state === "checkout_confirm") {
    if (cart.paymentMethod === "wallet") {
      // Wallet: the fulfillment keyboard carries the only way forward.
      const { total, payment } = app.orders.getPaymentInstructions(userId);
      await ctx.reply(
        walletPaymentSummaryText(total, payment.currency, app.customers.getBalance(userId)),
        {
          reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(new Date())),
        },
      );
      return;
    }
    // Card with the receipt attached but placement interrupted — retry.
    await finalizeOrder(ctx, app, {});
    return;
  }

  if (cart.state === "checkout_placed") {
    // A price change parked the placement — re-offer the retry, no AI.
    const { total, payment } = app.orders.getPaymentInstructions(userId);
    await ctx.reply(priceChangedText(total, payment.currency), {
      reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(new Date())),
    });
    return;
  }

  // Free-text edits for a recently placed order («فردا», «تحویل در کافه»).
  if (await tryApplyPlacedOrderText(ctx, app, text)) return;

  // browsing: natural-language ordering via AI (optional — buttons always work).
  await handleNaturalLanguage(ctx, app, text.slice(0, MAX_USER_MESSAGE_LENGTH));
}

async function handleNaturalLanguage(ctx: Context, app: BotApp, text: string): Promise<void> {
  const userId = ctx.from!.id;
  // The AI sees the full catalog including unavailable products so it can
  // honestly answer «ناموجود» questions; all mutations are still rejected by
  // the backend for inactive products.
  const catalog = app.menu.aiCatalog();
  const totals = app.cart.getTotals(userId);
  const { payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;
  const history = app.history.get(userId) ?? [];
  const cart = app.cart.getOrCreate(userId);
  const now = new Date();
  const isOpenNow = app.businessHours.isOpenAt(now);
  const afterHours = !isOpenNow;
  const aiSettings = getAiSettings(app.db);
  // AI disabled by the admin: free-text falls back to a friendly hint; the
  // deterministic menu/cart buttons keep working regardless.
  if (!aiSettings.enabled) {
    await ctx.reply(AI_FALLBACK_TEXT, { reply_markup: menuFor(app, userId) });
    return;
  }
  const profile = app.customers.getProfile(userId);
  const usual = aiSettings.suggestUsual ? app.loyalty.usualFor(userId) : null;

  log.info("text routed to ai", { userId, chars: text.length, state: cart.state });

  let result;
  try {
    result = await withTypingIndicator(
      ctx,
      app.ai.understand({
        message: text,
        history,
        catalog: {
          products: catalog.products,
          categories: catalog.categories.map((c) => ({ id: c.id, name: c.name })),
        },
        cartLines: totals.lines,
        currency,
        businessHours: app.businessHours.getHours(),
        checkoutState: cart.state,
        persona: aiSettings.persona,
        customerFirstName: aiSettings.personalizeGreeting ? profile?.fullName ?? null : null,
        isOpenNow,
        afterHours,
        usualItems:
          usual && usual.primary.length > 0
            ? usual.primary.map((u) => ({
                name: u.variantName ? `${u.productName} ${u.variantName}` : u.productName,
                timesOrdered: u.timesOrdered,
              }))
            : undefined,
      }),
    );
  } catch (err) {
    // understand() must not throw for network/model failures (they become an
    // "unavailable" result); reaching here means an unexpected application error.
    log.error("ai understand threw", { userId, err: String(err) });
    await ctx.reply(AI_FALLBACK_TEXT, { reply_markup: menuFor(app, userId) });
    return;
  }

  pushHistory(app, userId, { role: "user", content: text });

  try {
    switch (result.type) {
      case "product_offer":
      case "price_check": {
        await sendOfferCards(ctx, app, result);
        break;
      }
      case "cart_view": {
        if (result.reply && result.reply !== FALLBACK_REPLY) {
          await ctx.reply(result.reply);
        }
        await showCart(ctx, app, false);
        break;
      }
      case "checkout": {
        if (result.reply && result.reply !== FALLBACK_REPLY) {
          await ctx.reply(result.reply);
        }
        await startCheckoutFlow(ctx, app);
        break;
      }
      case "order_status": {
        // Status always comes from the database — the model only routes here.
        const latest = app.orders.latestOrderFor(userId);
        await ctx.reply(latest ? orderStatusText(latest) : NO_ORDERS_TEXT);
        break;
      }
      case "cart_action": {
        await applyCartActions(ctx, app, result);
        break;
      }
      case "profile_update": {
        // The model extracted profile facts; the backend re-validates them
        // (phone pattern, lengths) before anything is saved.
        await applyAiProfileUpdate(ctx, app, result);
        break;
      }
      default: {
        // chat / clarification — one normal reply with the validated text.
        if (result.reply) await ctx.reply(result.reply);
        break;
      }
    }
  } catch (err) {
    // Telegram delivery failed: log it and do NOT record an assistant turn —
    // the customer has not received the response.
    log.warn("telegram reply failed", { userId, type: result.type, err: String(err) });
    return;
  }

  pushHistory(app, userId, { role: "assistant", content: result.reply });
  log.info("ai reply delivered", { userId, type: result.type });
}

/** Render a confirmation/info card per resolved offer. */
async function sendOfferCards(ctx: Context, app: BotApp, result: AiResult): Promise<void> {
  const userId = ctx.from!.id;
  const { payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;
  const offers = (result.offers ?? []).slice(0, MAX_AI_OFFERS);
  const cartCount = app.cart.lineCount(userId);
  let sent = false;
  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i]!;
    const product = app.menu.getProduct(offer.productId, true);
    if (!product) continue;
    const resolved = app.menu.resolvePrice(offer.productId, offer.variantId);
    const available = resolved.ok;
    const variant = resolved.ok
      ? resolved.variant
      : product.variants.find((v) => v.id === offer.variantId) ?? null;
    const leadText =
      i === 0 && result.reply && result.reply !== FALLBACK_REPLY ? `${result.reply}\n\n` : "";
    const card = leadText + productCardText(product, variant, offer.quantity, available, currency);
    const alternatives = available
      ? []
      : app.menu.listProducts(product.categoryId, false).filter((p) => p.id !== product.id);
    const kb = offerKeyboard(
      userId,
      product,
      offer.variantId,
      offer.quantity,
      app.tokens,
      alternatives,
      cartCount,
    );
    sent = true;
    const imageUrl =
      product.imagePath && product.active
        ? `${app.config.appBaseUrl}/${product.imagePath}`
        : null;
    if (imageUrl && typeof (ctx as any).replyWithPhoto === "function") {
      try {
        await ctx.replyWithPhoto(imageUrl, { caption: card, reply_markup: kb });
        continue;
      } catch {
        /* fall through to a text card */
      }
    }
    await ctx.reply(card, { reply_markup: kb });
  }
  if (!sent) {
    // The model claimed products but none survived validation — ask, don't guess.
    const text = result.reply && result.reply !== FALLBACK_REPLY ? result.reply : FALLBACK_REPLY;
    await ctx.reply(text);
  }
}

/** Apply only backend-validated cart actions; clear requires confirmation. */
async function applyCartActions(ctx: Context, app: BotApp, result: AiResult): Promise<void> {
  const userId = ctx.from!.id;
  const { payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;

  const applied: string[] = [];
  const errors: string[] = [];
  let clearRequested = false;
  for (const action of result.actions) {
    if (action.type === "clear") {
      clearRequested = true;
      continue;
    }
    const qty = Math.max(1, Math.min(action.quantity ?? 1, MAX_ITEM_QUANTITY));
    if (action.type === "add") {
      const res = app.cart.addItem(userId, action.productId!, action.variantId ?? null, qty);
      if (res.ok) applied.push("افزودن");
      else errors.push(res.error);
    } else if (action.type === "set_qty") {
      const res = app.cart.setQty(
        userId,
        action.productId!,
        action.variantId ?? null,
        action.quantity ?? 1,
      );
      if (res.ok) applied.push("تعداد");
      else errors.push(res.error);
    } else if (action.type === "remove") {
      // Remove matching line(s) by product/variant, decreasing quantity first.
      const lines = app.cart
        .getTotals(userId)
        .lines.filter(
          (l) => l.productId === action.productId && (l.variantId ?? null) === (action.variantId ?? null),
        );
      if (lines.length === 0) {
        errors.push("این قلم در سبد شما نیست");
      } else {
        let left = qty;
        for (const line of lines) {
          while (left > 0) {
            const res = app.cart.changeQty(userId, line.cartItemId, -1);
            left -= 1;
            if (!res.ok) break;
          }
        }
        applied.push("حذف");
      }
    }
  }

  const after = app.orders.getPaymentInstructions(userId);

  if (clearRequested) {
    if (after.lines.length === 0) {
      await ctx.reply("سبد خرید شما از قبل خالی است.");
      return;
    }
    // Destructive: confirm before wiping the cart.
    await ctx.reply(
      `${cartText(after.lines, after.total, currency)}\n\nآیا از خالی کردن سبد خرید مطمئن هستید؟`,
      { reply_markup: clearConfirmKeyboard(userId, app.tokens) },
    );
    return;
  }

  const replyParts: string[] = [result.reply];
  if (errors.length > 0) replyParts.push(...errors.slice(0, 3));
  if (applied.length > 0 || result.actions.length > 0) {
    replyParts.push("");
    replyParts.push(cartText(after.lines, after.total, currency));
  }

  await ctx.reply(replyParts.filter(Boolean).join("\n"), {
    reply_markup:
      after.lines.length > 0 ? cartKeyboard(userId, after.lines, app.tokens) : menuFor(app, userId),
  });
}

/**
 * Apply AI-extracted profile fields conversationally («من محمد محمدی هستم»).
 * Only fields present in the message are changed; the phone is normalized
 * (Persian digits → English) and must match the mobile pattern.
 */
async function applyAiProfileUpdate(ctx: Context, app: BotApp, result: AiResult): Promise<void> {
  const userId = ctx.from!.id;
  const fields = result.profileFields ?? {};
  const existing = app.customers.getProfile(userId);

  // Name fallback chain: extracted → saved profile → Telegram sender name.
  const senderName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim();
  const fullName = fields.fullName ?? existing?.fullName ?? senderName ?? "";
  if (!fullName.trim()) {
    await ctx.reply("برای ثبت شماره، ابتدا نام خود را بگویید (مثلاً «من محمد محمدی هستم»).");
    return;
  }

  const input: { fullName: string; phone?: string | null; address?: string | null } = { fullName };
  if (fields.phone !== undefined) input.phone = fields.phone;
  if (fields.address !== undefined) input.address = fields.address;

  const r = app.customers.saveProfile(userId, input);
  const leadText = result.reply && result.reply !== FALLBACK_REPLY ? `${result.reply}\n\n` : "";
  if (!r.ok) {
    await ctx.reply(`${leadText}⚠️ ${r.error}`);
    return;
  }
  if (ctx.from) {
    app.customers.recordSender(userId, {
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
    });
  }
  const lines = [
    `نام: ${r.profile.fullName}`,
    r.profile.phone ? `موبایل: ${toPersianDigits(r.profile.phone)}` : null,
    r.profile.address ? `آدرس: ${r.profile.address}` : null,
  ].filter(Boolean);
  await ctx.reply(`${leadText}✅ پروفایل به‌روز شد.\n${lines.join("\n")}`, {
    reply_markup: menuFor(app, userId),
  });
}

interface ReceiptMedia {
  fileId: string;
  messageId: number;
  size?: number;
  mime?: string | null;
}

function extractReceipt(ctx: Context, kind: "photo" | "document"): ReceiptMedia | null {
  const msg = ctx.message!;
  const messageId = msg.message_id;
  if (kind === "photo" && msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return {
      fileId: largest.file_id,
      messageId,
      size: largest.file_size,
      mime: "image/jpeg",
    };
  }
  if (kind === "document" && msg.document) {
    const doc = msg.document;
    return {
      fileId: doc.file_id,
      messageId,
      size: doc.file_size,
      mime: doc.mime_type ?? null,
    };
  }
  return null;
}

async function handleReceiptMedia(
  ctx: Context,
  app: BotApp,
  kind: "photo" | "document",
): Promise<void> {
  const userId = ctx.from!.id;
  const cart = app.cart.getOrCreate(userId);

  if (cart.state !== "checkout_receipt" && cart.state !== "checkout_payment") {
    // Outside checkout, product images etc. are not used — be explicit.
    if (cart.state === "browsing") {
      const placed = app.orders.editableOrderFor(userId);
      if (placed) {
        // A re-sent screenshot after the order exists — point at the summary.
        await ctx.reply(RECEIPT_WRONG_STATE_TEXT, {
          reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(new Date())),
        });
        return;
      }
      await ctx.reply("برای ارسال رسید، ابتدا «پرداخت و ثبت سفارش» را از سبد خرید بزنید.", {
        reply_markup: menuFor(app, userId),
      });
      return;
    }
    // Wallet awaiting fulfillment, or a placement retry: the receipt is settled.
    await ctx.reply(RECEIPT_WRONG_STATE_TEXT, {
      reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(new Date())),
    });
    return;
  }

  const media = extractReceipt(ctx, kind);
  if (!media) {
    await ctx.reply("فایل تصویری نامعتبر است. لطفاً عکس رسید را ارسال کنید.");
    return;
  }
  const validation = validateReceipt({ kind, ...media });
  if (!validation.ok) {
    await ctx.reply(validation.error);
    return;
  }

  // The receipt places the order immediately (defaults: pickup, now) — the
  // customer only confirms delivery details with the buttons below.
  const name = ctx.from?.first_name
    ? `${ctx.from.first_name}${ctx.from.last_name ? " " + ctx.from.last_name : ""}`
    : null;
  const res = app.orders.placeOrderAfterReceipt(userId, validation.fileId, validation.messageId, name);
  if (!res.ok) {
    if (res.reason === "price_changed") {
      // The receipt is kept; the retry keyboard re-places at the new total.
      const { total, payment } = app.orders.getPaymentInstructions(userId);
      await ctx.reply(priceChangedText(total, payment.currency), {
        reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(new Date())),
      });
      return;
    }
    await ctx.reply(res.reason === "empty" ? "سبد خرید شما خالی است." : res.error, {
      reply_markup: menuFor(app, userId),
    });
    return;
  }
  if (ctx.from) {
    app.customers.recordSender(userId, {
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
    });
  }
  await ctx.reply(
    orderPlacedSummaryText(res.order, {
      lead: RECEIPT_PLACED_LEAD_TEXT,
      awaitingFulfillment: true,
    }),
    { reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(new Date())) },
  );
}

/**
 * Step-by-step profile wizard. Steps: name → phone → optional address.
 * The phone must match the mobile pattern; Persian/Arabic digits are
 * converted. Every step offers لغو / بعدی / تأیید buttons.
 */
async function applyProfileEdit(ctx: Context, app: BotApp, text: string, step = "default"): Promise<void> {
  await handleProfileWizardText(ctx, app, text, step);
}

/** Parse a fulfillment method out of free text (conservative patterns). */
function parseFulfillmentMethod(text: string): "delivery" | "pickup" | null {
  if (/(ارسال|پیک|آدرس|ارسال به)/i.test(text)) return "delivery";
  if (/(حضوری|خودم|کافه|تحویل)/i.test(text)) return "pickup";
  return null;
}

/**
 * Parse a fulfillment time out of free text. Returns a concrete label, `null`
 * for an explicit reset, or `undefined` when the text is not a time at all.
 */
function parseFulfillmentTime(
  text: string,
  now: Date,
  timeZone: string,
): string | null | undefined {
  const t = text.trim();
  if (/^(الان|همین الان|فوری|فورا|asap)$/i.test(t)) {
    return quickFulfillmentTimeLabel("now", now, timeZone);
  }
  if (/^فردا/.test(t)) {
    return quickFulfillmentTimeLabel("tomorrow", now, timeZone);
  }
  if (/^(۵|5)\s*دقیقه/.test(t)) {
    return quickFulfillmentTimeLabel("5m", now, timeZone);
  }
  if (/^(۱۰|10)\s*دقیقه/.test(t)) {
    return quickFulfillmentTimeLabel("10m", now, timeZone);
  }
  if (/^ساعت/.test(t)) {
    return t.slice(0, 100);
  }
  if (/^(پیش‌فرض|پیشفرض|پیش فرض|default)$/i.test(t)) {
    return null;
  }
  return undefined;
}

/**
 * Free text about a recently placed order («فردا», «تحویل در کافه», «ساعت ۵
 * عصر») edits it in place; anything unrecognized falls through to the AI.
 * Returns true when the message was consumed as a fulfillment edit.
 */
async function tryApplyPlacedOrderText(ctx: Context, app: BotApp, text: string): Promise<boolean> {
  const userId = ctx.from!.id;
  const order = app.orders.editableOrderFor(userId);
  if (!order) return false;
  const now = new Date();
  const method = parseFulfillmentMethod(text);
  const time = parseFulfillmentTime(text, now, app.config.timezone);
  if (!method && time === undefined) return false;
  // Immediate-time phrases (الان / +۵ / +۱۰ دقیقه) are refused while the café
  // is closed — the order belongs to the next business day, not «الان».
  if (typeof time === "string" && !app.businessHours.isOpenAt(now)) {
    const immediate = (["now", "5m", "10m"] as const).map((c) =>
      quickFulfillmentTimeLabel(c, now, app.config.timezone),
    );
    if ((immediate as readonly string[]).includes(time)) {
      await ctx.reply(CLOSED_IMMEDIATE_TIME_TEXT, {
        reply_markup: placedFulfillmentKeyboard(
          !!app.customers.getProfile(userId)?.address,
          false,
        ),
      });
      return true;
    }
  }
  const update: { method?: "delivery" | "pickup"; time?: string | null } = {};
  if (method) update.method = method;
  if (time !== undefined) update.time = time;
  const r = app.orders.updateFulfillment(order.id, userId, update);
  if (!r.ok) {
    await ctx.reply(r.error, {
      reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(now)),
    });
    return true;
  }
  await ctx.reply(orderPlacedSummaryText(r.order, { lead: ORDER_PLACED_LEAD_TEXT }), {
    reply_markup: placedFulfillmentKeyboard(!!app.customers.getProfile(userId)?.address, app.businessHours.isOpenAt(now)),
  });
  return true;
}

/** Parse a deposit amount, create the pending request, show payment instructions. */
async function applyDepositAmount(ctx: Context, app: BotApp, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const raw = text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[,\s]/g, "");
  const amount = Number(raw);
  const r = app.customers.createDeposit(userId, amount);
  if (!r.ok) {
    await ctx.reply(`${r.error}\n\nمبلغ را دوباره بفرستید یا /cancel را بزنید.`);
    app.depositFlow.expect(userId);
    return;
  }
  const { payment } = app.orders.getPaymentInstructions(userId);
  if (!cardToCardAvailable(payment)) {
    await ctx.reply(
      `درخواست شارژ #${r.deposit.id} ثبت شد، اما شارژ کیف پول در حال حاضر غیرفعال است؛ بعداً دوباره تلاش کنید.`,
      { reply_markup: walletKeyboard() },
    );
    return;
  }
  await ctx.reply(
    [
      `🧾 درخواست شارژ #${r.deposit.id} ثبت شد.`,
      `مبلغ: ${formatMoney(r.deposit.amount, payment.currency)}`,
      "",
      "لطفاً کارت به کارت کنید و تصویر رسید را ارسال کنید:",
      `شماره کارت: ${payment.cardNumber}`,
      `به نام: ${payment.cardholderName || "—"}`,
      "",
      "پس از تأیید ادمین، موجودی شما شارژ می‌شود.",
    ].join("\n"),
    {
      reply_markup: cardCopyKeyboard(r.deposit.amount, payment.cardNumber || null)
        .row()
        .text("📜 تاریخچه کیف پول", "whist")
        .row()
        .text("🏠 منوی اصلی", "m"),
    },
  );
}

/** Validate and register a manually entered referral code. */
async function applyReferralCode(ctx: Context, app: BotApp, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const r = app.referrals.applyReferral(userId, text, "manual");
  if (r.ok) {
    const referrerName = app.customers.getProfile(r.relation.referredBy)?.fullName || null;
    await ctx.reply(referralSuccessText(referrerName), { reply_markup: menuFor(app, userId) });
    return;
  }
  if (r.code === "already_registered") {
    await ctx.reply(REFERRAL_ALREADY_TEXT, { reply_markup: menuFor(app, userId) });
    return;
  }
  const message =
    r.code === "self_referral"
      ? REFERRAL_SELF_TEXT
      : r.code === "not_found"
        ? REFERRAL_NOT_FOUND_TEXT
        : REFERRAL_INVALID_TEXT;
  await ctx.reply(message, { reply_markup: referralEntryKeyboard() });
  // Re-arm so the customer can retry without pressing the button again.
  app.referralFlow.expect(userId);
}

/**
 * Admin typed the rejection reason for a card receipt (armed by the لغو
 * button). Persists the rejection with the reason, then notifies the customer
 * with BOTH the receipt image and the reason text in one photo message.
 */
async function applyRejectReason(
  ctx: Context,
  app: BotApp,
  orderId: number | null,
  text: string,
): Promise<void> {
  const adminId = ctx.from!.id;
  if (!app.config.adminIds.has(adminId)) return; // flow is admin-only; belt & braces
  const reason = text.trim().slice(0, 500);
  if (!reason) {
    // Re-arm so the admin can simply type the reason again.
    if (orderId !== null) app.rejectReasonFlow.expect(adminId, String(orderId));
    await ctx.reply("دلیل نمی‌تواند خالی باشد. دوباره بنویسید یا /cancel بزنید.");
    return;
  }
  const order = orderId !== null ? app.orders.loadOrder(orderId) : null;
  if (!order || order.paymentStatus === "paid" || order.paymentStatus === "rejected") {
    await ctx.reply("این سفارش دیگر قابل بررسی نیست.");
    return;
  }
  const r = app.orders.markPaymentRejected(orderId!, adminId, reason);
  if (!r.ok) {
    await ctx.reply(r.error);
    return;
  }
  if (!r.already) {
    // Persist-before-notify: markPaymentRejected already committed. Same refKey
    // as the panel path, so a later panel reject is a no-op for the customer.
    app.notifications.enqueue(
      "customer_notice",
      `payment_rejected_${r.order.orderNumber}`,
      [r.order.customerTelegramId],
      {
        text: paymentRejectedCustomerText(r.order.orderNumber, reason),
        ...(r.order.receiptFileId ? { photoFileId: r.order.receiptFileId } : {}),
      },
    );
  }
  await ctx.reply(
    r.already
      ? "این رسید قبلاً رد شده بود؛ دلیل جدیدی ثبت نشد."
      : "رسید رد شد و دلیل به‌همراه تصویر رسید برای مشتری ارسال شد.",
  );
}
