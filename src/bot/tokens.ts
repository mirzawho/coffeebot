import type { Db } from "../db/database";
import { nowIso } from "../db/database";

/**
 * One-shot action tokens for mutating inline-keyboard callbacks.
 * Minted when a keyboard is rendered; consumed atomically on first press so
 * double-taps and stale re-deliveries cannot apply the same operation twice.
 */
export class TokenService {
  constructor(private readonly db: Db) {}

  /** Mint a fresh token bound to a user + action key (e.g. "a:12:34"). */
  mint(telegramId: number, actionKey: string): string {
    this.cleanup();
    const token = cryptoRandom(8);
    this.db
      .query(
        "INSERT INTO action_tokens (token, telegram_id, action, used, created_at) VALUES (?, ?, ?, 0, ?)",
      )
      .run(token, telegramId, actionKey, nowIso());
    return token;
  }

  /**
   * Atomically consume a token. Returns true only for the first valid press
   * by the owning user; false for stale, used, foreign, or unknown tokens.
   */
  consume(telegramId: number, token: string, expectedAction: string): boolean {
    const res = this.db
      .query(
        `UPDATE action_tokens SET used = 1
         WHERE token = ? AND telegram_id = ? AND action = ? AND used = 0`,
      )
      .run(token, telegramId, expectedAction);
    return res.changes === 1;
  }

  /** Invalidate all unused tokens for a user (called when a view is re-rendered). */
  invalidateForUser(telegramId: number): void {
    this.db.query("DELETE FROM action_tokens WHERE telegram_id = ? AND used = 0").run(telegramId);
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    this.db.query("DELETE FROM action_tokens WHERE created_at < ?").run(cutoff);
  }
}

function cryptoRandom(hexLen: number): string {
  const bytes = new Uint8Array(hexLen / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
