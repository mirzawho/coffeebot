import { Bot } from "grammy";
import type { BotApp } from "./context";
import { registerCallbackHandlers } from "./handlers/callbacks";
import { registerMessageHandlers } from "./handlers/messages";
import { registerAdminEntry, configureAdminMenuButtons } from "./admin-entry";
import { log } from "../utils/logger";
import { botState } from "./state";

export { botState };

export function createBot(app: BotApp): Bot {
  // Optional HTTP CONNECT proxy for reaching api.telegram.org from restricted
  // networks (Bun fetch: proxy option; socks5 is not supported by Bun).
  const baseFetchConfig = app.config.outboundProxyUrl
    ? { proxy: app.config.outboundProxyUrl }
    : undefined;
  if (baseFetchConfig) log.info("telegram proxy enabled", { proxy: app.config.outboundProxyUrl });
  const bot = new Bot(app.config.botToken, { client: { baseFetchConfig } });

  bot.catch((err) => {
    log.error("bot error", { err: String(err.error) });
  });

  registerCallbackHandlers(bot, app);
  registerMessageHandlers(bot, app);
  registerAdminEntry(bot, app);

  return bot;
}

const MAX_START_ATTEMPTS = 5;
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

export function backoffDelay(attempt: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_MS);
}

/**
 * Supervised startup: delete any stale webhook, then begin long-polling.
 * Transient failures are retried with bounded backoff. `isRunning()` is
 * checked before each retry so a successful start never creates a second
 * polling loop. On permanent failure (bot.stop() called, or attempts
 * exhausted) the promise resolves with `failed` and botState records it —
 * callers decide how to surface that (health endpoint, exit).
 */
export async function startBot(bot: Bot, opts?: { maxAttempts?: number }): Promise<"running" | "failed"> {
  const maxAttempts = opts?.maxAttempts ?? MAX_START_ATTEMPTS;
  botState.running = false;
  botState.failed = false;
  botState.lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    botState.attempts = attempt;
    try {
      // Guard against duplicate polling loops: if a previous attempt is
      // still running (isRunning true), do not start again.
      if (bot.isRunning()) {
        botState.running = true;
        return "running";
      }
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      // bot.start() resolves only when polling stops; it kicks off the loop
      // synchronously before its first await, so a "successful" return of the
      // setup phase is observable via bot.isRunning().
      void bot
        .start({
          onStart: (info) => {
            botState.running = true;
            botState.failed = false;
            botState.lastError = null;
            log.info("bot started", { username: info.username });
          },
          timeout: 30,
        })
        .catch((err) => {
          // Polling loop itself crashed after start — mark failed so health
          // reports reality; a process supervisor (restart policy) recovers.
          botState.running = false;
          botState.failed = true;
          botState.lastError = String(err?.message ?? err).slice(0, 200);
          log.error("bot polling loop crashed", { err: botState.lastError });
        });
      // Give the first getUpdates a brief moment; onStart sets running=true.
      // If deleteWebhook succeeded but onStart hasn't fired, treat as started:
      // grammY sets isRunning() as soon as the loop is launched.
      if (bot.isRunning()) {
        botState.running = true;
        log.info("bot polling launched", { attempt });
        return "running";
      }
      // Start launched but not yet confirmed running — small settle wait.
      await Bun.sleep(200);
      if (bot.isRunning()) {
        botState.running = true;
        log.info("bot polling launched", { attempt });
        return "running";
      }
      throw new Error("bot polling did not start");
    } catch (err) {
      const msg = String((err as any)?.message ?? err).slice(0, 200);
      botState.lastError = msg;
      botState.running = false;
      log.warn("bot startup attempt failed", { attempt, maxAttempts, err: msg });
      if (attempt === maxAttempts) {
        botState.failed = true;
        log.error("bot startup permanently failed", { attempts: attempt, err: msg });
        return "failed";
      }
      const delay = backoffDelay(attempt);
      log.info("bot startup retry scheduled", { attempt, delayMs: delay });
      await Bun.sleep(delay);
    }
  }
  botState.failed = true;
  return "failed";
}
