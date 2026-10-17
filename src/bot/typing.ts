import type { Context } from "grammy";

/**
 * Customer-facing AI response delivery:
 *  - a self-cleaning typing-indicator loop (Telegram actions expire ~5s)
 *  - one normal reply once the complete response is ready
 *
 * Nothing here touches cart/checkout state; failures degrade to plain replies.
 */

const TYPING_INTERVAL_MS = 4000; // Telegram actions expire ~5s; refresh sooner.

/**
 * Periodically re-send the typing action while `work` is running.
 * The loop always terminates when work settles (resolved, rejected, or threw).
 * Typing failures are logged and never affect the response. Resolves with the
 * work result; rejects only if the work itself rejects.
 */
export async function withTypingIndicator<T>(
  ctx: Context,
  work: Promise<T>,
  intervalMs: number = TYPING_INTERVAL_MS,
): Promise<T> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sendTyping = async () => {
    if (stopped) return;
    try {
      await ctx.replyWithChatAction("typing");
    } catch {
      /* indicator is best-effort; never block or fail the response */
    }
  };

  void sendTyping();
  const tick = async () => {
    if (stopped) return;
    await sendTyping();
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  try {
    return await work;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}
