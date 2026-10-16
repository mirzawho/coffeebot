import type { Context } from "grammy";
import type { BotApp } from "../context";
import { pushHistory } from "../context";
import {
  cartKeyboard,
  checkoutKeyboard,
  clearConfirmKeyboard,
  deliveryKeyboard,
  fulfillmentKeyboard,
  mainMenu,
  offerKeyboard,
  paymentMethodKeyboard,
} from "../keyboards";
import {
  AI_FALLBACK_TEXT,
  cartText,
  confirmSummaryText,
  DELIVERY_PROMPT_TEXT,
  HELP_TEXT,
  NO_ORDERS_TEXT,
  orderStatusText,
  PAYMENT_CHOICE_PROMPT_TEXT,
  productCardText,
  RECEIPT_PROMPT_TEXT,
  RECEIPT_WRONG_STATE_TEXT,
  UNSUPPORTED_TEXT,
  WELCOME_TEXT,
} from "../format";
import { MAX_AI_OFFERS, MAX_ITEM_QUANTITY, MAX_USER_MESSAGE_LENGTH } from "../../utils/ids";
import { FALLBACK_REPLY, type AiResult } from "../../services/ollama";
import { normalizePhone, MAX_ADDRESS_LENGTH } from "../../services/customers";
import { cardToCardAvailable, getAiSettings } from "../../services/settings";
import { validateReceipt } from "../receipt";
import { isIdentityQuestion, buildIdentityReply } from "../identity";
import { log } from "../../utils/logger";
import { showHelp, showMainMenu, showCart, startCheckoutFlow, startProfileEdit, sendConfirmStage, sendFulfillmentChoice } from "./callbacks";
import { withTypingIndicator, TelegramStreamer } from "../typing";
import { walletKeyboard } from "../keyboards";
import { formatMoney } from "../../utils/money";
import { toPersianDigits } from "../../utils/dates";

/** Register /start, /help, text (AI + delivery notes) and photo/document handlers. */
export function registerMessageHandlers(bot: any, app: BotApp): void {
  bot.command("start", async (ctx: Context) => {
    app.cart.getOrCreate(ctx.from!.id);
    await ctx.reply(WELCOME_TEXT, { reply_markup: mainMenu() });
    // First run: a customer without a saved profile is walked through it once.
    if (!app.customers.isProfileComplete(ctx.from!.id)) {
      await startProfileEdit(ctx, app);
    }
  });

  bot.command("help", async (ctx: Context) => {
    await ctx.reply(HELP_TEXT, { reply_markup: mainMenu() });
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
    // Commands are handled by their registered command handlers.
    if (text === "/start" || text === "/help" || text === "/whoami" || text === "/admin" || text === "/cancel") return;
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

  if (text === "/cancel") {
    app.profileEdit.clear(userId);
    app.depositFlow.clear(userId);
    app.fulfillmentTimeFlow.clear(userId);
  }

  // Active text-capture flows take precedence (profile wizard, deposit amount,
  // fulfillment time). The step is read before clearing so multi-field
  // wizards know which question was last asked.
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
  if (app.fulfillmentTimeFlow.isActive(userId)) {
    app.fulfillmentTimeFlow.clear(userId);
    await applyFulfillmentTime(ctx, app, text);
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
    const { payment } = app.orders.getPaymentInstructions(userId);
    await ctx.reply(PAYMENT_CHOICE_PROMPT_TEXT, {
      reply_markup: paymentMethodKeyboard({
        walletBalance: app.customers.getBalance(userId),
        total: app.cart.getTotals(userId).total,
        walletEnabled: payment.walletEnabled,
        cardEnabled: cardToCardAvailable(payment),
      }),
    });
    return;
  }

  if (cart.state === "checkout_receipt") {
    await ctx.reply(RECEIPT_PROMPT_TEXT, { reply_markup: checkoutKeyboard(userId, "receipt", app.tokens) });
    return;
  }

  if (cart.state === "checkout_fulfillment") {
    await ctx.reply("برای انتخاب روش تحویل از دکمه‌ها استفاده کنید.", {
      reply_markup: fulfillmentKeyboard(!!app.customers.getProfile(userId)?.address),
    });
    return;
  }

  if (cart.state === "checkout_confirm") {
    const notes = text.slice(0, 500);
    const res = app.orders.setDeliveryNotes(userId, notes);
    if (!res.ok) {
      await ctx.reply(res.error);
      return;
    }
    await sendConfirmStage(ctx, app);
    return;
  }

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
    await ctx.reply(AI_FALLBACK_TEXT, { reply_markup: mainMenu() });
    return;
  }
  const profile = app.customers.getProfile(userId);
  const usual = aiSettings.suggestUsual ? app.loyalty.usualFor(userId) : null;

  log.info("text routed to ai", { userId, chars: text.length, state: cart.state });

  // Progressive display for the model's customer-facing text. The intent JSON
  // itself is never streamed — only the validated `reply` is shown.
  const streamer = new TelegramStreamer(ctx);
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
        onDelta: (delta) => streamer.append(delta),
      }),
    );
  } catch (err) {
    // understand() must not throw for network/model failures (they become an
    // "unavailable" result); reaching here means an unexpected application error.
    log.error("ai understand threw", { userId, err: String(err) });
    await streamer.finalize().catch(() => {});
    await ctx.reply(AI_FALLBACK_TEXT, { reply_markup: mainMenu() });
    return;
  }

  pushHistory(app, userId, { role: "user", content: text });

  try {
    switch (result.type) {
      case "product_offer":
      case "price_check": {
        // The streamed text (if any) is the model's lead-in; finalize it, then
        // append the confirmation cards.
        const lead = await streamer.finalize();
        await sendOfferCards(ctx, app, result, lead);
        break;
      }
      case "cart_view": {
        const lead = await streamer.finalize();
        if (lead && lead !== FALLBACK_REPLY) {
          // Lead already delivered via the stream; just show the cart after it.
        } else if (result.reply && result.reply !== FALLBACK_REPLY) {
          await ctx.reply(result.reply);
        }
        await showCart(ctx, app, false);
        break;
      }
      case "checkout": {
        const lead = await streamer.finalize();
        if (!lead && result.reply && result.reply !== FALLBACK_REPLY) {
          await ctx.reply(result.reply);
        }
        await startCheckoutFlow(ctx, app);
        break;
      }
      case "order_status": {
        // Status always comes from the database — the model only routes here.
        await streamer.finalize().catch(() => {});
        const latest = app.orders.latestOrderFor(userId);
        await ctx.reply(latest ? orderStatusText(latest) : NO_ORDERS_TEXT);
        break;
      }
      case "cart_action": {
        const lead = await streamer.finalize();
        await applyCartActions(ctx, app, result, lead);
        break;
      }
      case "profile_update": {
        // The model extracted profile facts; the backend re-validates them
        // (phone pattern, lengths) before anything is saved.
        const lead = await streamer.finalize();
        await applyAiProfileUpdate(ctx, app, result, lead);
        break;
      }
      default: {
        // chat / clarification — the streamed text IS the reply; finalize
        // delivers it exactly once (or sends it fresh if nothing streamed).
        const delivered = await streamer.finalize();
        if (!delivered && result.reply) await ctx.reply(result.reply);
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

/** Render a confirmation/info card per resolved offer. `lead` is the already-delivered streamed text. */
async function sendOfferCards(ctx: Context, app: BotApp, result: AiResult, lead = ""): Promise<void> {
  const userId = ctx.from!.id;
  const { payment } = app.orders.getPaymentInstructions(userId);
  const currency = payment.currency;
  const offers = (result.offers ?? []).slice(0, MAX_AI_OFFERS);
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
      i === 0 && lead && lead !== FALLBACK_REPLY
        ? `${lead}\n\n`
        : i === 0 && !lead && result.reply && result.reply !== FALLBACK_REPLY
          ? `${result.reply}\n\n`
          : "";
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
    const text = lead && lead !== FALLBACK_REPLY ? lead : result.reply && result.reply !== FALLBACK_REPLY ? result.reply : FALLBACK_REPLY;
    await ctx.reply(text);
  }
}

/** Apply only backend-validated cart actions; clear requires confirmation. */
async function applyCartActions(ctx: Context, app: BotApp, result: AiResult, lead = ""): Promise<void> {
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

  const after = app.cart.getTotals(userId);

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

  // The streamed lead (if any) already reached the customer; don't repeat it.
  const replyParts: string[] = lead && lead !== FALLBACK_REPLY ? [] : [result.reply];
  if (errors.length > 0) replyParts.push(...errors.slice(0, 3));
  if (applied.length > 0 || result.actions.length > 0) {
    replyParts.push("");
    replyParts.push(cartText(after.lines, after.total, currency));
  }

  await ctx.reply(replyParts.filter(Boolean).join("\n"), {
    reply_markup:
      after.lines.length > 0 ? cartKeyboard(userId, after.lines, app.tokens) : mainMenu(),
  });
}

/**
 * Apply AI-extracted profile fields conversationally («من محمد محمدی هستم»).
 * Only fields present in the message are changed; the phone is normalized
 * (Persian digits → English) and must match the mobile pattern.
 */
async function applyAiProfileUpdate(ctx: Context, app: BotApp, result: AiResult, lead = ""): Promise<void> {
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
  if (!r.ok) {
    const text = `${lead && lead !== FALLBACK_REPLY ? lead + "\n\n" : ""}⚠️ ${r.error}`;
    await ctx.reply(text);
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
  const text = `${lead && lead !== FALLBACK_REPLY ? lead + "\n\n" : ""}✅ پروفایل به‌روز شد.\n${lines.join("\n")}`;
  await ctx.reply(text, { reply_markup: mainMenu() });
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
      await ctx.reply("برای ارسال رسید، ابتدا «تسویه حساب» را بزنید.", {
        reply_markup: mainMenu(),
      });
      return;
    }
    // Fulfillment/confirm stages: the receipt is already recorded — a re-sent
    // or duplicate screenshot must not silently replace it.
    await ctx.reply(RECEIPT_WRONG_STATE_TEXT, {
      reply_markup:
        cart.state === "checkout_fulfillment"
          ? fulfillmentKeyboard(!!app.customers.getProfile(userId)?.address)
          : checkoutKeyboard(userId, "confirm", app.tokens),
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

  const res = app.orders.attachReceipt(userId, validation.fileId, validation.messageId);
  if (!res.ok) {
    await ctx.reply(res.error);
    return;
  }
  await ctx.reply("✅ رسید دریافت شد.");
  await sendFulfillmentChoice(ctx, app);
}

/**
 * Step-by-step profile wizard. Steps: name → phone → optional address.
 * The phone must match the mobile pattern; Persian/Arabic digits are
 * converted. /cancel aborts (handled by the command handler clearing flows).
 */
async function applyProfileEdit(ctx: Context, app: BotApp, text: string, step = "default"): Promise<void> {
  const userId = ctx.from!.id;

  if (step === "name") {
    const name = text.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
    if (name.length < 2) {
      await ctx.reply("نام واردشده کوتاه است. لطفاً نام و نام خانوادگی را کامل بفرستید:");
      app.profileEdit.expect(userId, "name"); // stay on the same step
      return;
    }
    wizardState.set(userId, { fullName: name });
    app.profileEdit.expect(userId, "phone");
    await ctx.reply(
      [
        "۲ از ۳ — شماره موبایل خود را بفرستید:",
        "مثلاً ۰۹۱۲۳۴۵۶۷۸۹ (اعداد فارسی هم قابل قبول است)",
        "",
        "برای لغو /cancel را بفرستید.",
      ].join("\n"),
    );
    return;
  }

  if (step === "phone") {
    const saved = wizardState.get(userId) ?? {};
    const phone = normalizePhone(text);
    if (!phone) {
      await ctx.reply(
        "شماره موبایل معتبر نیست. لطفاً یک شماره ۱۱ رقمی مثل ۰۹۱۲۳۴۵۶۷۸۹ بفرستید:",
      );
      app.profileEdit.expect(userId, "phone"); // stay on the same step
      return;
    }
    saved.phone = phone;
    wizardState.set(userId, saved);
    app.profileEdit.expect(userId, "address");
    await ctx.reply(
      [
        "۳ از ۳ — آدرس محل تحویل را بنویسید (اختیاری):",
        "اگر آدرس ندارید یا می‌خواهید حضوری تحویل بگیرید، «رد» بفرستید.",
        "",
        "برای لغو /cancel را بفرستید.",
      ].join("\n"),
    );
    return;
  }

  if (step === "address") {
    const saved = wizardState.get(userId) ?? {};
    const skip = /^(رد|نه|خیر|-|—|skip)$/i.test(text.trim());
    const address = skip ? null : text.trim().slice(0, MAX_ADDRESS_LENGTH) || null;
    wizardState.delete(userId);
    const r = app.customers.saveProfile(userId, {
      fullName: saved.fullName ?? "",
      phone: saved.phone ?? null,
      address,
    });
    if (!r.ok) {
      await ctx.reply(`${r.error}\n\nدوباره تلاش کنید یا /cancel را بفرستید.`);
      app.profileEdit.expect(userId, "address");
      return;
    }
    // Keep the Telegram username in sync with the validated sender.
    if (ctx.from) {
      app.customers.recordSender(userId, {
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
      });
    }
    await ctx.reply(
      [
        "✅ پروفایل ذخیره شد.",
        `نام: ${r.profile.fullName}`,
        `موبایل: ${r.profile.phone ? toPersianDigits(r.profile.phone) : "—"}`,
        r.profile.address ? `آدرس: ${r.profile.address}` : "آدرس: ثبت نشده",
      ].join("\n"),
      { reply_markup: mainMenu() },
    );
    return;
  }

  app.profileEdit.clear(userId);
}

/** Scratch state for the multi-step profile wizard (name/phone before save). */
const wizardState = new Map<number, { fullName?: string; phone?: string }>();
const MAX_PROFILE_NAME_LENGTH = 80;

/**
 * Capture the requested delivery/pickup time («ساعت ۵ عصر», «الان»).
 * «پیش‌فرض»/skip leaves it empty — the café prepares the order ASAP.
 */
async function applyFulfillmentTime(ctx: Context, app: BotApp, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const cart = app.cart.get(userId);
  if (!cart || cart.state !== "checkout_confirm") {
    await ctx.reply("این مرحله دیگر معتبر نیست؛ دوباره از «تسویه حساب» شروع کنید.", {
      reply_markup: mainMenu(),
    });
    return;
  }
  const skip = /^(پیش‌فرض|پیشفرض|پیش فرض|الان نه|رد|نه|-|—|skip|default)$/i.test(text.trim());
  app.cart.setFulfillmentTime(userId, skip ? null : text.trim());
  await sendConfirmStage(ctx, app);
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
    { reply_markup: walletKeyboard() },
  );
}
