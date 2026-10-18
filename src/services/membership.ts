import type { Db } from "../db/database";
import { nowIso } from "../db/database";
import { getSetting, setSetting } from "./settings";
import { log } from "../utils/logger";

/**
 * Telegram channel membership enforcement.
 *
 * Settings live in the existing `settings` table:
 *   channel_membership_enabled  "0"/"1" (default "0" — never block by accident)
 *   channel_membership_channel  normalized "@username" (empty = not configured)
 *   channel_membership_message  optional custom Persian prompt (empty = default)
 *
 * Last known verification results live in `channel_membership`, keyed by the
 * stable Telegram user id. Results are cached info, not guaranteed truth —
 * customers can leave the channel at any time. An `unknown` result means the
 * Telegram API could not be queried (permissions/network); it is NEVER
 * treated as non-membership.
 */

export type MembershipStatus = "member" | "not_member" | "unknown";

export interface ChannelMembershipSettings {
  enabled: boolean;
  /** Normalized "@username", or null when not configured. */
  channel: string | null;
  /** "https://t.me/username" for the join button, or null. */
  channelUrl: string | null;
  /** Resolved customer-facing prompt (custom or default). */
  message: string;
  messageIsDefault: boolean;
}

export interface MembershipCheck {
  status: MembershipStatus;
  checkedAt: string;
  /** True when the result came from the short-lived in-memory cache. */
  fromCache: boolean;
}

export interface MembershipRecord {
  status: MembershipStatus;
  channel: string;
  checkedAt: string;
}

export const DEFAULT_JOIN_MESSAGE =
  "برای استفاده از ربات، لطفاً ابتدا عضو کانال ما شو. بعد از عضویت روی دکمه «عضو شدم، بررسی کن» بزن. 😊";

export const MAX_JOIN_MESSAGE_LENGTH = 500;

/** Telegram public usernames: 5–32 chars, start with a letter. */
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * Normalize a channel identifier to "@username". Accepts "@name", bare
 * "name", and public "https://t.me/name" links. Invite links (t.me/+…,
 * t.me/joinchat/…) cannot be used with getChatMember by username and are
 * rejected. Returns null when the input is not a usable public identifier.
 */
export function normalizeChannel(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^@([A-Za-z][A-Za-z0-9_]{4,31})$/);
  if (m) return `@${m[1]}`;
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i);
  if (m) return `@${m[1]}`;
  m = s.match(/^([A-Za-z][A-Za-z0-9_]{4,31})$/);
  if (m) return `@${m[1]}`;
  return null;
}

/** Map a Telegram ChatMember payload to our tri-state status. */
export function mapChatMemberStatus(member: {
  status: string;
  is_member?: boolean;
}): MembershipStatus {
  if (member.status === "creator" || member.status === "administrator" || member.status === "member") {
    return "member";
  }
  if (member.status === "restricted") {
    // A restricted user is still a member exactly when Telegram says so.
    return member.is_member === true ? "member" : "not_member";
  }
  if (member.status === "left" || member.status === "kicked") {
    return "not_member";
  }
  // Unknown future status — never guess non-membership.
  return "unknown";
}

export function getMembershipSettings(db: Db): ChannelMembershipSettings {
  const rawChannel = getSetting(db, "channel_membership_channel").trim();
  const channel = normalizeChannel(rawChannel);
  const custom = getSetting(db, "channel_membership_message").trim();
  return {
    // Explicitly enabled only; a missing key must never block customers.
    enabled: getSetting(db, "channel_membership_enabled") === "1",
    channel,
    channelUrl: channel ? `https://t.me/${channel.slice(1)}` : null,
    message: custom || DEFAULT_JOIN_MESSAGE,
    messageIsDefault: !custom,
  };
}

/** True when enforcement can actually run (switch on + valid channel). */
export function membershipEnforced(settings: ChannelMembershipSettings): boolean {
  return settings.enabled && settings.channel !== null;
}

export function updateMembershipSettings(
  db: Db,
  input: { enabled?: boolean; channel?: string; message?: string },
): ChannelMembershipSettings {
  if (input.channel !== undefined) {
    const normalized = normalizeChannel(input.channel);
    const raw = String(input.channel ?? "").trim();
    if (raw && !normalized) {
      throw new Error(
        "شناسه کانال معتبر نیست. یک یوزرنیم عمومی مثل @my_channel یا لینک https://t.me/my_channel وارد کنید (لینک دعوت پشتیبانی نمی‌شود).",
      );
    }
    setSetting(db, "channel_membership_channel", normalized ?? "");
  }
  if (input.message !== undefined) {
    const msg = String(input.message ?? "").trim();
    if (msg.length > MAX_JOIN_MESSAGE_LENGTH) {
      throw new Error(`پیام عضویت بیش از حد مجاز طولانی است (حداکثر ${MAX_JOIN_MESSAGE_LENGTH} کاراکتر)`);
    }
    setSetting(db, "channel_membership_message", msg);
  }
  if (input.enabled !== undefined) {
    if (input.enabled) {
      // Refuse enabling without a usable channel — otherwise every customer
      // would be blocked with no way through.
      const current = normalizeChannel(getSetting(db, "channel_membership_channel"));
      if (!current) {
        throw new Error("برای فعال‌سازی عضویت کانال، ابتدا شناسه کانال را وارد کنید");
      }
    }
    setSetting(db, "channel_membership_enabled", input.enabled ? "1" : "0");
  }
  return getMembershipSettings(db);
}

/** The minimal ChatMember shape this service understands. */
export interface ChatMemberLike {
  status: string;
  is_member?: boolean;
}

/**
 * Membership verification with a short-lived in-memory cache. The Telegram
 * API client is attached after the bot is constructed (`attach`), so the
 * service is usable in tests and admin routes without a live bot.
 */
export class ChannelMembershipService {
  /** Short-lived cache: enough to absorb button-mashing, short enough that a
   * fresh join is usually visible on the next explicit recheck. */
  private static readonly CACHE_TTL_MS = 30_000;

  private cache = new Map<number, { status: MembershipStatus; at: number }>();
  private getChatMemberFn:
    | ((chatId: string, userId: number) => Promise<ChatMemberLike>)
    | null = null;

  constructor(private readonly db: Db) {}

  /** Wire the live Telegram client (called once at startup). */
  attach(api: {
    getChatMember(chatId: string | number, userId: number): Promise<ChatMemberLike>;
  }): void {
    this.getChatMemberFn = (chatId, userId) => api.getChatMember(chatId, userId);
  }

  settings(): ChannelMembershipSettings {
    return getMembershipSettings(this.db);
  }

  /**
   * Verify a user's membership in the configured channel. `fresh` bypasses
   * the in-memory cache (explicit «عضو شدم، بررسی کن» presses and admin
   * rechecks). Failures are recorded as `unknown`, never as `not_member`.
   *
   * Only the caller's own Telegram id may be checked from customer flows —
   * the guard always passes ctx.from.id and never accepts an id from
   * callback data or message text.
   */
  async check(userId: number, opts?: { fresh?: boolean }): Promise<MembershipCheck> {
    const settings = getMembershipSettings(this.db);

    if (!settings.channel) {
      // No channel configured: nothing to verify against. Report unknown so
      // callers never mistake this for confirmed non-membership.
      return { status: "unknown", checkedAt: nowIso(), fromCache: false };
    }

    if (!opts?.fresh) {
      const cached = this.cache.get(userId);
      if (cached && Date.now() - cached.at < ChannelMembershipService.CACHE_TTL_MS) {
        return { status: cached.status, checkedAt: nowIso(), fromCache: true };
      }
    }

    if (!this.getChatMemberFn) {
      const status: MembershipStatus = "unknown";
      this.record(userId, status, settings.channel);
      return { status, checkedAt: nowIso(), fromCache: false };
    }

    try {
      const member = await this.getChatMemberFn(settings.channel, userId);
      const status = mapChatMemberStatus(member);
      this.cache.set(userId, { status, at: Date.now() });
      this.record(userId, status, settings.channel);
      return { status, checkedAt: nowIso(), fromCache: false };
    } catch (err) {
      // Log diagnostics without dumping the full error object (may embed
      // request payloads). userId is needed to correlate support requests.
      const description = String((err as any)?.description ?? (err as any)?.message ?? err).slice(0, 200);
      log.warn("channel membership check failed", {
        userId,
        channel: settings.channel,
        err: description,
      });
      const status: MembershipStatus = "unknown";
      this.cache.set(userId, { status, at: Date.now() });
      this.record(userId, status, settings.channel);
      return { status, checkedAt: nowIso(), fromCache: false };
    }
  }

  /** Last known record for the admin panel (cached info, not live truth). */
  recordFor(userId: number): MembershipRecord | null {
    const r = this.db
      .query("SELECT status, channel, checked_at FROM channel_membership WHERE telegram_id = ?")
      .get(userId) as { status: string; channel: string; checked_at: string } | null;
    if (!r) return null;
    return {
      status: (r.status as MembershipStatus) ?? "unknown",
      channel: r.channel,
      checkedAt: r.checked_at,
    };
  }

  private record(userId: number, status: MembershipStatus, channel: string): void {
    this.db
      .query(
        `INSERT INTO channel_membership (telegram_id, status, channel, checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           status = excluded.status, channel = excluded.channel, checked_at = excluded.checked_at`,
      )
      .run(userId, status, channel, nowIso());
  }
}
