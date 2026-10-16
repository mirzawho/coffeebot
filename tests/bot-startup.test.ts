import { describe, test, expect, beforeEach } from "bun:test";
import { startBot, backoffDelay } from "../src/bot/index";
import { botState } from "../src/bot/state";
import { Bot } from "grammy";

/** Minimal Bot stand-in: we only exercise deleteWebhook + isRunning + start. */
function fakeBot(opts: {
  failWebhookTimes?: number;
  startCrashes?: boolean;
  startRuns?: boolean;
}): any {
  let webhookFailures = opts.failWebhookTimes ?? 0;
  let running = false;
  return {
    api: {
      deleteWebhook: async () => {
        if (webhookFailures > 0) {
          webhookFailures--;
          throw new Error("401: Unauthorized");
        }
        return { ok: true, result: true };
      },
    },
    isRunning: () => running,
    start: () => {
      if (opts.startCrashes) {
        running = false;
        return Promise.reject(new Error("polling crashed"));
      }
      if (opts.startRuns !== false) {
        running = true;
      }
      return new Promise(() => {}); // never resolves (polling loop)
    },
    stop: () => {
      running = false;
    },
  };
}

beforeEach(() => {
  botState.running = false;
  botState.failed = false;
  botState.lastError = null;
  botState.attempts = 0;
});

describe("bot startup supervision (BUG-005 regression)", () => {
  test("backoff is bounded and exponential", () => {
    expect(backoffDelay(0)).toBe(2000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(10)).toBeLessThanOrEqual(60_000);
  });

  test("successful first start resolves running and sets botState", async () => {
    const bot = fakeBot({});
    const result = await startBot(bot as unknown as Bot, { maxAttempts: 3 });
    expect(result).toBe("running");
    expect(botState.running).toBe(true);
    expect(botState.failed).toBe(false);
  });

  test("transient webhook failure recovers on retry without duplicate loops", async () => {
    const bot = fakeBot({ failWebhookTimes: 1 });
    const result = await startBot(bot as unknown as Bot, { maxAttempts: 3 });
    expect(result).toBe("running");
    expect(botState.attempts).toBeGreaterThanOrEqual(2);
    expect(botState.running).toBe(true);
    // Only one effective start: isRunning guard.
    expect(bot.isRunning()).toBe(true);
  });

  test("permanent failure resolves failed and is observable in botState", async () => {
    const bot = fakeBot({ failWebhookTimes: 99 });
    // maxAttempts=2 => sleeps 2s between attempts; allow headroom.
    const result = await startBot(bot as unknown as Bot, { maxAttempts: 2 });
    expect(result).toBe("failed");
    expect(botState.failed).toBe(true);
    expect(botState.running).toBe(false);
    expect(botState.lastError).toContain("401");
  }, 15000);

  test("does not start a second loop if already running", async () => {
    const bot = fakeBot({});
    let starts = 0;
    const origStart = bot.start;
    bot.start = (...args: any[]) => {
      starts++;
      return origStart(...args);
    };
    await startBot(bot as unknown as Bot, { maxAttempts: 2 });
    // A second supervision call must detect isRunning and not call start again.
    const second = await startBot(bot as unknown as Bot, { maxAttempts: 2 });
    expect(second).toBe("running");
    expect(starts).toBe(1);
  });

  test("real grammY Bot instance works with the supervision wrapper (offline: webhook fails, retries, terminal)", async () => {
    // A real grammY Bot with an unreachable API: deleteWebhook will fail.
    // Use maxAttempts=1 to keep the test fast; expect terminal failure state.
    const bot = new Bot("123456:TEST-TOKEN-NOT-REAL");
    const result = await startBot(bot, { maxAttempts: 1 });
    expect(result).toBe("failed");
    expect(botState.failed).toBe(true);
    expect(botState.lastError).toBeTruthy();
    // Token must not appear in the recorded error.
    expect(botState.lastError).not.toContain("TEST-TOKEN-NOT-REAL");
  }, 20000);
});
