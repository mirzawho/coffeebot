import { describe, test, expect } from "bun:test";
import {
  validateInitData,
  requireAdmin,
  signInitData,
  extractInitData,
  AuthError,
  INIT_DATA_MAX_AGE_SECONDS,
} from "../src/api/middleware/auth";
import { RateLimiter } from "../src/api/middleware/rate-limit";

const TOKEN = "123456:ABC-DEF_ghi";
const ADMIN = { id: 777, first_name: "Admin", username: "admin" };
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);

describe("validateInitData", () => {
  test("accepts valid signed initData", () => {
    const raw = signInitData(TOKEN, ADMIN, NOW_S);
    const v = validateInitData(raw, TOKEN, NOW);
    expect(v.user.id).toBe(777);
    expect(v.user.first_name).toBe("Admin");
  });

  test("rejects tampered hash", () => {
    const raw = signInitData(TOKEN, ADMIN, NOW_S).replace(/hash=[0-9a-f]+/i, `hash=${"0".repeat(64)}`);
    expect(() => validateInitData(raw, TOKEN, NOW)).toThrow(AuthError);
  });

  test("rejects tampered user id (signature mismatch)", () => {
    const raw = signInitData(TOKEN, ADMIN, NOW_S);
    // Flip the user id inside the signed payload.
    const params = new URLSearchParams(raw);
    const user = JSON.parse(params.get("user")!);
    user.id = 999;
    params.set("user", JSON.stringify(user));
    expect(() => validateInitData(params.toString(), TOKEN, NOW)).toThrow(AuthError);
  });

  test("rejects stale initData", () => {
    const raw = signInitData(TOKEN, ADMIN, NOW_S - INIT_DATA_MAX_AGE_SECONDS - 60);
    expect(() => validateInitData(raw, TOKEN, NOW)).toThrow(/expired|stale/i);
  });

  test("rejects forged initData signed with wrong bot token", () => {
    const raw = signInitData("999:WRONG", ADMIN, NOW_S);
    expect(() => validateInitData(raw, TOKEN, NOW)).toThrow(AuthError);
  });

  test("rejects missing hash", () => {
    const params = new URLSearchParams(signInitData(TOKEN, ADMIN, NOW_S));
    params.delete("hash");
    expect(() => validateInitData(params.toString(), TOKEN, NOW)).toThrow(AuthError);
  });

  test("rejects empty / oversized input", () => {
    expect(() => validateInitData("", TOKEN, NOW)).toThrow(AuthError);
    expect(() => validateInitData("x".repeat(9000), TOKEN, NOW)).toThrow(AuthError);
  });

  test("rejects missing user", () => {
    const params = new URLSearchParams(signInitData(TOKEN, ADMIN, NOW_S));
    params.delete("user");
    params.delete("hash");
    // Re-sign after modification so the HMAC is valid but user is gone.
    const pairs: [string, string][] = [];
    for (const [k, v] of params.entries()) pairs.push([k, v]);
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const dcs = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
    const { createHmac } = require("node:crypto");
    const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
    params.set("hash", createHmac("sha256", secret).update(dcs).digest("hex"));
    expect(() => validateInitData(params.toString(), TOKEN, NOW)).toThrow(/user/i);
  });

  test("rejects future auth_date beyond small clock skew", () => {
    const raw = signInitData(TOKEN, ADMIN, NOW_S + 3600);
    expect(() => validateInitData(raw, TOKEN, NOW)).toThrow(AuthError);
  });
});

describe("requireAdmin", () => {
  const valid = validateInitData(signInitData(TOKEN, ADMIN, NOW_S), TOKEN, NOW);

  test("allows member of ADMIN_IDS", () => {
    expect(requireAdmin(valid, new Set([777])).id).toBe(777);
  });

  test("rejects non-admin with 403", () => {
    try {
      requireAdmin(valid, new Set([1, 2, 3]));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
    }
  });
});

describe("RateLimiter", () => {
  test("allows up to limit then blocks within window", () => {
    const rl = new RateLimiter(3, 60_000);
    expect(rl.check("ip1", 0)).toBe(true);
    expect(rl.check("ip1", 0)).toBe(true);
    expect(rl.check("ip1", 0)).toBe(true);
    expect(rl.check("ip1", 0)).toBe(false);
    // Different key unaffected
    expect(rl.check("ip2", 0)).toBe(true);
    // After window reset
    expect(rl.check("ip1", 61_000)).toBe(true);
  });
});

describe("extractInitData", () => {
  const payload = signInitData(TOKEN, ADMIN, NOW_S);

  test("reads the x-telegram-init-data header (case-insensitive)", () => {
    const req = new Request("http://x/api/admin/me", {
      headers: { "X-Telegram-Init-Data": payload },
    });
    expect(extractInitData(req)).toBe(payload);
  });

  test("accepts the Authorization: tma <initData> form", () => {
    const req = new Request("http://x/api/admin/me", {
      headers: { authorization: `tma ${payload}` },
    });
    expect(extractInitData(req)).toBe(payload);
  });

  test("prefers the header over the query param", () => {
    const req = new Request(`http://x/api/admin/me?initData=other`, {
      headers: { "x-telegram-init-data": payload },
    });
    expect(extractInitData(req, { allowQuery: true })).toBe(payload);
  });

  test("ignores query params unless explicitly allowed (dev only)", () => {
    const req = new Request(`http://x/api/admin/me?initData=${encodeURIComponent(payload)}`);
    expect(extractInitData(req)).toBeNull();
    expect(extractInitData(req, { allowQuery: true })).toBe(payload);
  });

  test("returns null when nothing is present", () => {
    expect(extractInitData(new Request("http://x/api/admin/me"))).toBeNull();
  });

  test("ignores blank header values", () => {
    const req = new Request("http://x/api/admin/me", {
      headers: { "x-telegram-init-data": "   " },
    });
    expect(extractInitData(req)).toBeNull();
  });
});
