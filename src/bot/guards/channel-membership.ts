import type { Context, MiddlewareFn } from "grammy";
import type { BotApp } from "../context";
import { joinChannelKeyboard } from "../keyboards";
import { log } from "../../utils/logger";
import {
  getMembershipSettings,
  membershipEnforced,
  type ChannelMembershipSettings,
} from "../../services/membership";

/** Callback data for «عضو شدم، بررسی کن» (must stay under 64 bytes). */
export const MEMBERSHIP_RECHECK_CB = "ch:check";

export const MEMBERSHIP_VERIFY_FAILED_TEXT =
  "⚠️ بررسی عضویت در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید. " +
  "اگر هنوز به کانال نپیوسته‌اید، اول عضو شوید و سپس دکمه «عضو شدم، بررسی کن» را بزنید.";

export const MEMBERSHIP_STILL_REQUIRED_TEXT =
  "هنوز عضو کانال نشده‌اید. لطفاً ابتدا روی «عضویت در کانال» بزنید و عضو شوید، " +
  "سپس «عضو شدم، بررسی کن» را بزنید. 😊";

export const MEMBERSHIP_GRANTED_TEXT =
  "✅ عضویت شما تأیید شد. خوش آمدید! از منو می‌توانید سفارش دهید.";

function joinPrompt(settings: ChannelMembershipSettings): {
  text: string;
  reply_markup: ReturnType<typeof joinChannelKeyboard>;
} {
  return {
    text: settings.message,
    reply_markup: joinChannelKeyboard(settings.channelUrl!),
  };
}

async function replyJoinPrompt(ctx: Context, settings: ChannelMembershipSettings): Promise<void> {
  await ctx.reply(joinPrompt(settings).text, {
    reply_markup: joinPrompt(settings).reply_markup,
  });
}

/**
 * Handle the explicit recheck press. Always performs a FRESH verification
 * (bypasses the short-lived cache) — that is the whole point of the button.
 * Only ctx.from.id is ever checked; callback data carries no user id.
 */
async function handleRecheck(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const settings = getMembershipSettings(app.db);
  if (!membershipEnforced(settings)) {
    // Enforcement was turned off (or channel cleared) since the prompt was
    // shown — let the user through by falling back to the main flow.
    await ctx.answerCallbackQuery({ text: "عضویت کانال دیگر الزامی نیست ✓" }).catch(() => {});
    return;
  }
  const result = await app.membership.check(userId, { fresh: true });
  if (result.status === "member") {
    await ctx.answerCallbackQuery({ text: "عضویت تأیید شد ✓" }).catch(() => {});
    // Edit the prompt message in place so a recheck never stacks messages.
    try {
      await ctx.editMessageText(MEMBERSHIP_GRANTED_TEXT);
    } catch {
      await ctx.reply(MEMBERSHIP_GRANTED_TEXT);
    }
    return;
  }
  if (result.status === "unknown") {
    await ctx
      .answerCallbackQuery({ text: "بررسی ناموفق؛ کمی بعد دوباره تلاش کنید", show_alert: true })
      .catch(() => {});
    // Refresh the prompt (same keyboard) without claiming non-membership.
    try {
      await ctx.editMessageText(MEMBERSHIP_VERIFY_FAILED_TEXT, {
        reply_markup: joinChannelKeyboard(settings.channelUrl!),
      });
    } catch {
      await replyJoinPromptText(ctx, MEMBERSHIP_VERIFY_FAILED_TEXT, settings);
    }
    return;
  }
  // Confirmed not a member — keep the restriction, re-show the prompt.
  await ctx
    .answerCallbackQuery({ text: "هنوز عضو کانال نشده‌اید", show_alert: true })
    .catch(() => {});
  try {
    await ctx.editMessageText(MEMBERSHIP_STILL_REQUIRED_TEXT, {
      reply_markup: joinChannelKeyboard(settings.channelUrl!),
    });
  } catch {
    await replyJoinPromptText(ctx, MEMBERSHIP_STILL_REQUIRED_TEXT, settings);
  }
}

async function replyJoinPromptText(
  ctx: Context,
  text: string,
  settings: ChannelMembershipSettings,
): Promise<void> {
  await ctx.reply(text, { reply_markup: joinChannelKeyboard(settings.channelUrl!) });
}

/**
 * Centralized channel-membership guard. Registered as grammY middleware
 * BEFORE every customer handler, so commands, text/AI messages, photos
 * (receipts) and callback queries all pass through it — none of the handlers
 * need their own membership check.
 *
 * Exemptions (pass straight through):
 *  - administrators (config.adminIds) — admin workflows are never blocked;
 *  - updates without a user (channel posts etc. — the bot only receives
 *    direct messages anyway, but be defensive);
 *  - the feature is disabled or no valid channel is configured.
 *
 * The recheck callback (`ch:check`) is handled here (not in callbacks.ts) so
 * it works while the user is still restricted, and it never falls through to
 * customer handlers.
 */
export function channelMembershipGuard(app: BotApp): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return next();

    // Admins are exempt: authorization rules stay exactly as they were.
    if (app.config.adminIds.has(userId)) return next();

    const settings = getMembershipSettings(app.db);
    if (!membershipEnforced(settings)) return next();

    const data = ctx.callbackQuery?.data;
    if (data === MEMBERSHIP_RECHECK_CB) {
      await handleRecheck(ctx, app);
      return; // never falls through to other callback handlers
    }

    let status;
    try {
      status = (await app.membership.check(userId)).status;
    } catch (err) {
      // check() should not throw; belt & braces — treat as unverifiable.
      log.error("membership guard check threw", { userId, err: String(err) });
      status = "unknown";
    }

    if (status === "member") return next();

    if (ctx.callbackQuery) {
      // Blocked callback: acknowledge so the client stops spinning, then put
      // the join prompt IN PLACE of the pressed message (an edit, not a new
      // message — button mashing cannot stack duplicates). If the edit fails
      // (message too old / identical), fall back to a throttled fresh prompt.
      if (status === "unknown") {
        await ctx
          .answerCallbackQuery({
            text: "بررسی عضویت ممکن نیست؛ لطفاً بعداً دوباره تلاش کنید",
            show_alert: true,
          })
          .catch(() => {});
        await editOrThrottledPrompt(ctx, settings, MEMBERSHIP_VERIFY_FAILED_TEXT);
      } else {
        await ctx
          .answerCallbackQuery({ text: "ابتدا عضو کانال شوید ✓", show_alert: true })
          .catch(() => {});
        await editOrThrottledPrompt(ctx, settings, settings.message);
      }
      return;
    }

    if (status === "unknown") {
      await replyJoinPromptText(ctx, MEMBERSHIP_VERIFY_FAILED_TEXT, settings);
      return;
    }
    await replyJoinPrompt(ctx, settings);
  };
}

/** Last time we sent a FRESH join prompt per user (edit fallback spam guard). */
const lastPromptAt = new Map<number, number>();
const PROMPT_THROTTLE_MS = 10_000;

async function editOrThrottledPrompt(
  ctx: Context,
  settings: ChannelMembershipSettings,
  text: string,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      reply_markup: joinChannelKeyboard(settings.channelUrl!),
    });
    return;
  } catch {
    /* message not editable — fall through to throttled send */
  }
  const userId = ctx.from!.id;
  const now = Date.now();
  const last = lastPromptAt.get(userId) ?? 0;
  if (now - last < PROMPT_THROTTLE_MS) return;
  lastPromptAt.set(userId, now);
  if (lastPromptAt.size > 1000) {
    // Bound the map: drop the oldest entries.
    const oldest = lastPromptAt.keys().next().value;
    if (oldest !== undefined) lastPromptAt.delete(oldest);
  }
  await ctx
    .reply(text, { reply_markup: joinChannelKeyboard(settings.channelUrl!) })
    .catch(() => {});
}
