import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Telegram Mini App initData validation per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Never trust initDataUnsafe: identity is only accepted after HMAC verification.
 */

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  /** Profile photo URL, when Telegram includes it in the signed payload. */
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TelegramUser;
  authDate: number;
  raw: Map<string, string>;
}

/** Max age of initData before it is considered stale. */
export const INIT_DATA_MAX_AGE_SECONDS = 12 * 3600;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function validateInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
  maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS,
): ValidatedInitData {
  if (!initData || typeof initData !== "string" || initData.length > 8192) {
    throw new AuthError("initData missing or too large");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new AuthError("initData hash missing or malformed");
  }

  // Build the data-check-string: all pairs except hash, sorted, joined with \n.
  const pairs: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash.toLowerCase(), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("initData signature invalid");
  }

  const authDateRaw = params.get("auth_date");
  const authDate = Number(authDateRaw);
  if (!Number.isInteger(authDate) || authDate <= 0) {
    throw new AuthError("initData auth_date invalid");
  }
  const ageSeconds = Math.floor(now / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -300) {
    throw new AuthError("initData expired, please reopen the Mini App", 401);
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new AuthError("initData has no user");
  }
  let userObj: any;
  try {
    userObj = JSON.parse(userRaw);
  } catch {
    throw new AuthError("initData user payload malformed");
  }
  if (!userObj || !Number.isInteger(userObj.id) || userObj.id <= 0) {
    throw new AuthError("initData user id invalid");
  }

  const user: TelegramUser = {
    id: userObj.id,
    first_name: String(userObj.first_name ?? ""),
    last_name: userObj.last_name ? String(userObj.last_name) : undefined,
    username: userObj.username ? String(userObj.username) : undefined,
    language_code: userObj.language_code ? String(userObj.language_code) : undefined,
    // Only accept https URLs — this value is rendered as an image src.
    photo_url:
      typeof userObj.photo_url === "string" && /^https:\/\//.test(userObj.photo_url)
        ? userObj.photo_url
        : undefined,
  };

  return {
    user,
    authDate,
    raw: new Map(pairs),
  };
}

/** Authorization gate: authenticated Telegram user must be in ADMIN_IDS. */
export function requireAdmin(
  validated: ValidatedInitData,
  adminIds: Set<number>,
): TelegramUser {
  if (!adminIds.has(validated.user.id)) {
    throw new AuthError("not authorized", 403);
  }
  return validated.user;
}

/** Build signed initData for tests (simulates Telegram). */
export function signInitData(
  botToken: string,
  user: TelegramUser,
  authDate: number,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(authDate));
  params.set("query_id", "test-query");
  for (const [k, v] of Object.entries(extra)) params.set(k, v);

  const pairs: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}
