import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotApp } from "./context";
import { log } from "../utils/logger";

/**
 * Telegram entry point to the admin Mini App.
 *
 * `APP_BASE_URL` is the public HTTPS origin the Mini App is served from. The
 * panel is only *discoverable* here — every protected API request is still
 * authorized server-side by Telegram initData HMAC validation plus the
 * `ADMIN_IDS` allowlist. Showing the button never grants privileges.
 */

/** Normalize the configured origin into the Mini App URL (served at "/"). */
export function adminWebAppUrl(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/`;
}

/** Inline keyboard with a Telegram Web App button that opens the admin panel. */
export function adminEntryKeyboard(appBaseUrl: string): InlineKeyboard {
  return new InlineKeyboard().webApp("🛠 پنل مدیریت", adminWebAppUrl(appBaseUrl));
}

export const ADMIN_ONLY_TEXT = "این دستور فقط برای مدیران است.";
export const ADMIN_ENTRY_TEXT = "پنل مدیریت کافه:";

/**
 * Register the `/admin` command. Non-admins get a neutral refusal; admins get a
 * Web App button. Authorization is enforced server-side, not by this check.
 */
export function registerAdminEntry(bot: Bot, app: BotApp): void {
  bot.command("admin", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !app.config.adminIds.has(userId)) {
      await ctx.reply(ADMIN_ONLY_TEXT);
      return;
    }
    await ctx.reply(ADMIN_ENTRY_TEXT, { reply_markup: adminEntryKeyboard(app.config.appBaseUrl) });
  });
}

/**
 * Best-effort: point each configured admin's chat menu button at the Mini App.
 * A failure for one account is logged and never stops the customer bot — the
 * `/admin` command remains a usable fallback entry point.
 */
export async function configureAdminMenuButtons(bot: Bot, app: BotApp): Promise<void> {
  const url = adminWebAppUrl(app.config.appBaseUrl);
  for (const adminId of app.config.adminIds) {
    try {
      await bot.api.setChatMenuButton({
        chat_id: adminId,
        menu_button: { type: "web_app", text: "پنل مدیریت", web_app: { url } },
      });
    } catch (err) {
      log.warn("admin menu button setup failed", {
        adminId,
        err: String(err).slice(0, 200),
      });
    }
  }
}
