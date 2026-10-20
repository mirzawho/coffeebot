import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BotApp } from "./context";
import { cardViewKeyboard, cardEditConfirmKeyboard } from "./keyboards";
import { menuFor } from "./handlers/messages";
import {
  CARD_CANCELLED_TEXT,
  CARD_NUMBER_PROMPT_TEXT,
  CARD_RETRY_PROMPT_TEXT,
  cardEditConfirmText,
  cardMenuText,
  cardSavedText,
} from "./format";

/**
 * Single-step bank-card wizard. The customer is asked for a 16-digit card
 * number; `saveCard` validates format + Luhn before writing, so an invalid
 * entry never overwrites a previously saved card. The full number is never
 * echoed back — only the masked form is shown. State lives in
 * `app.cardEdit` (a TextCaptureFlow keyed by userId); there is no separate
 * draft map because only one field is collected.
 */

/** Show the customer's registered card (or the empty state) with actions. */
export async function showCardMenu(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const card = app.customers.getCard(userId);
  await ctx.reply(cardMenuText(card?.masked ?? null), {
    reply_markup: cardViewKeyboard(!!card, card?.last4 ?? null),
  });
}

/**
 * Start editing. When a card already exists, first show a confirmation
 * keyboard («ادامه» / «لغو」) so the current card is never replaced by a
 * stray press; with no saved card the capture flow is armed immediately.
 */
export async function startCardEdit(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const existing = app.customers.getCard(userId);
  if (existing) {
    await ctx.reply(cardEditConfirmText(existing.masked), {
      reply_markup: cardEditConfirmKeyboard(),
    });
    return;
  }
  await askCardNumber(ctx, app);
}

/** «ادامه» on the edit-confirmation keyboard: arm the flow and ask. */
export async function cardWizardConfirmEdit(ctx: Context, app: BotApp): Promise<void> {
  await askCardNumber(ctx, app);
}

/** Arm the capture flow and ask for the 16-digit number. */
async function askCardNumber(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  app.cardEdit.expect(userId, "cardNumber");
  await ctx.reply(CARD_NUMBER_PROMPT_TEXT, {
    reply_markup: new InlineKeyboard().text("❌ لغو", "cd:cancel"),
  });
}

/**
 * Consume the card-number text. On validation failure the flow is re-armed
 * (same step) so the customer can retry without pressing the button again;
 * on success the flow is cleared and only the masked number is echoed.
 */
export async function handleCardWizardText(
  ctx: Context,
  app: BotApp,
  text: string,
  step: string,
): Promise<void> {
  const userId = ctx.from!.id;
  if (step !== "cardNumber") {
    // Defensive: an unknown step means the flow state is stale — drop it.
    app.cardEdit.clear(userId);
    return;
  }
  const r = app.customers.saveCard(userId, text);
  if (!r.ok) {
    // saveCard validated before writing: the previously saved card (if any)
    // is untouched. Re-arm so the next text is captured again.
    app.cardEdit.expect(userId, "cardNumber");
    await ctx.reply(`${r.error}\n\n${CARD_RETRY_PROMPT_TEXT}`, {
      reply_markup: new InlineKeyboard().text("❌ لغو", "cd:cancel"),
    });
    return;
  }
  app.cardEdit.clear(userId);
  await ctx.reply(cardSavedText(r.card.masked), { reply_markup: menuFor(app, userId) });
}

/** «لغو»: abort without touching the saved card; show the current card state. */
export async function cardWizardCancel(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  app.cardEdit.clear(userId);
  const card = app.customers.getCard(userId);
  await ctx.reply(`${CARD_CANCELLED_TEXT}\n\n${cardMenuText(card?.masked ?? null)}`, {
    reply_markup: cardViewKeyboard(!!card, card?.last4 ?? null),
  });
}
