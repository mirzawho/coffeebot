import type { Context, MiddlewareFn } from "grammy";
import type { BotApp } from "../context";
import { getMembershipSettings } from "../../services/membership";

/** Callback data for «عضو شدم، بررسی کن» (must stay under 64 bytes). */
export const MEMBERSHIP_RECHECK_CB = "ch:check";

export const MEMBERSHIP_GRANTED_TEXT =
  "✅ عضویت شما تأیید شد. خوش آمدید! از منو می‌توانید سفارش دهید.";

/**
 * Join URL for the main-menu button, or null when the button shouldn't show
 * (feature off, no channel, or the user already is / isn't verifiably a
 * non-member). Uses the membership service's short-lived cache.
 */
export async function membershipJoinUrl(app: BotApp, userId: number): Promise<string | null> {
  const settings = getMembershipSettings(app.db);
  if (!settings.enabled || !settings.channelUrl) return null;
  const result = await app.membership.check(userId);
  return result.status === "not_member" ? settings.channelUrl : null;
}

/**
 * Membership is OPTIONAL — it never blocks the bot. This middleware only
 * handles the «عضو شدم، بررسی کن» button from the main-menu join row
 * (always a FRESH verification; only ctx.from.id is checked).
 */
export function channelMembershipGuard(app: BotApp): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (ctx.callbackQuery?.data !== MEMBERSHIP_RECHECK_CB) return next();

    const userId = ctx.from!.id;
    const settings = getMembershipSettings(app.db);
    if (!settings.enabled || !settings.channel) {
      await ctx.answerCallbackQuery({ text: "عضویت کانال دیگر فعال نیست ✓" }).catch(() => {});
      return;
    }
    const result = await app.membership.check(userId, { fresh: true });
    if (result.status === "member") {
      await ctx.answerCallbackQuery({ text: "عضویت تأیید شد ✓" }).catch(() => {});
      try {
        await ctx.editMessageText(MEMBERSHIP_GRANTED_TEXT);
      } catch {
        /* message too old / identical — the toast answer is enough */
      }
      return;
    }
    if (result.status === "unknown") {
      await ctx
        .answerCallbackQuery({ text: "بررسی ناموفق؛ کمی بعد دوباره تلاش کنید", show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx
      .answerCallbackQuery({ text: "هنوز عضو کانال نشده‌اید", show_alert: true })
      .catch(() => {});
  };
}
