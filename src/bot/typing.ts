import type { Context } from "grammy";
import { log } from "../utils/logger";

/**
 * Customer-facing AI response delivery:
 *  - a self-cleaning typing-indicator loop (Telegram actions expire ~5s)
 *  - progressive message updates (placeholder + throttled edits) for streamed text
 *  - safe HTML formatting with a plain-text fallback
 *
 * Nothing here touches cart/checkout state; failures degrade to plain replies.
 */

const TYPING_INTERVAL_MS = 4000; // Telegram actions expire ~5s; refresh sooner.
const EDIT_INTERVAL_MS = 1500; // Telegram edit throttle.
const MIN_DELTA_FOR_EDIT = 40; // ...or meaningful new text, whichever first.
const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Periodically re-send the typing action while `work` is running.
 * The loop always terminates when work settles (resolved, rejected, or threw).
 * Typing failures are logged and never affect the response. Resolves with the
 * work result; rejects only if the work itself rejects.
 */
export async function withTypingIndicator<T>(ctx: Context, work: Promise<T>): Promise<T> {
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
    if (!stopped) timer = setTimeout(tick, TYPING_INTERVAL_MS);
  };
  timer = setTimeout(tick, TYPING_INTERVAL_MS);

  try {
    return await work;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

/** Escape text for safe interpolation into Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert model Markdown-ish text to safe Telegram HTML. Only a small,
 * allowlisted subset is converted (bold, italic, inline code, code blocks);
 * everything else is escaped plain text. Never throws on odd input.
 */
export function toTelegramHtml(text: string): string {
  try {
    const blocks: string[] = [];
    // Extract fenced code blocks first so their content is not double-processed.
    let rest = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) => {
      blocks.push(`<code>${escapeHtml(code.replace(/\n$/, ""))}</code>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    rest = escapeHtml(rest);
    rest = rest
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return rest.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? "");
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Progressive Telegram updater: sends a placeholder lazily on the first flush,
 * then edits at most once per EDIT_INTERVAL_MS or MIN_DELTA_FOR_EDIT chars.
 * Content longer than one Telegram message falls back to a final plain send.
 */
export class TelegramStreamer {
  private full = "";
  private messageId: number | null = null;
  private lastSent = "";
  private lastEditAt = 0;
  private pending = false;
  private closed = false;
  /** Set when content outgrew a single message; final send uses reply(). */
  private overflowed = false;
  private parseMode: "HTML" | null;

  constructor(
    private readonly ctx: Context,
    parseMode: "HTML" | null = "HTML",
  ) {
    this.parseMode = parseMode;
  }

  /** Accept a raw model delta; schedules a throttled UI update. */
  append(delta: string): void {
    if (this.closed) return;
    this.full += delta;
    if (this.full.length > TELEGRAM_MESSAGE_LIMIT - 200) {
      // Too long for one message: stop editing, deliver complete text at the end.
      this.overflowed = true;
      return;
    }
    if (this.pending) return;
    const due =
      Date.now() - this.lastEditAt >= EDIT_INTERVAL_MS ||
      this.full.length - this.lastSent.length >= MIN_DELTA_FOR_EDIT;
    if (!due) return;
    this.pending = true;
    void this.flush();
  }

  private async flush(): Promise<void> {
    const text = this.full;
    this.pending = false;
    if (this.closed || !text.trim() || text === this.lastSent) return;
    try {
      if (this.messageId === null) {
        const msg = await this.ctx.reply(this.render(text), { parse_mode: this.parseMode ?? undefined });
        this.messageId = msg.message_id;
      } else {
        await this.ctx.editMessageText(this.render(text), {
          parse_mode: this.parseMode ?? undefined,
        });
      }
      this.lastSent = text;
      this.lastEditAt = Date.now();
    } catch (err) {
      // Edit failures (rate limit, parse error) must not kill the stream; the
      // final send below still delivers the complete text as plain text.
      log.warn("stream edit failed", { err: String((err as any)?.message ?? err).slice(0, 120) });
      this.parseMode = null;
    }
  }

  private render(text: string): string {
    return this.parseMode === "HTML" ? toTelegramHtml(text) : text;
  }

  /**
   * Finish the stream. Returns the complete accumulated text; guarantees the
   * customer ends with exactly one final message (no duplicate full replies).
   */
  async finalize(): Promise<string> {
    this.closed = true;
    const text = this.full.trim();
    if (!text) return "";
    if (this.overflowed || this.messageId === null) {
      // Nothing (or too much) streamed: one clean final message, plain text
      // if HTML rendering previously failed.
      const body = this.overflowed ? text : this.render(text);
      try {
        const msg = await this.ctx.reply(body, {
          parse_mode: this.overflowed ? undefined : (this.parseMode ?? undefined),
        });
        this.messageId = msg.message_id;
        this.lastSent = text;
        return text;
      } catch (err) {
        log.warn("stream final send failed", { err: String((err as any)?.message ?? err).slice(0, 120) });
        return text;
      }
    }
    // A placeholder exists: one last edit if content changed since last flush.
    if (text !== this.lastSent) {
      try {
        await this.ctx.editMessageText(this.render(text), {
          parse_mode: this.parseMode ?? undefined,
        });
        this.lastSent = text;
      } catch (err) {
        log.warn("stream final edit failed", { err: String((err as any)?.message ?? err).slice(0, 120) });
      }
    }
    return text;
  }
}
