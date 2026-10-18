import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { loadConfig } from "../src/config";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { NotificationService } from "../src/services/notifications";
import { updatePaymentSettings } from "../src/services/settings";
import {
  ChannelMembershipService,
  getMembershipSettings,
  updateMembershipSettings,
  normalizeChannel,
  mapChatMemberStatus,
  DEFAULT_JOIN_MESSAGE,
} from "../src/services/membership";
import {
  channelMembershipGuard,
  MEMBERSHIP_RECHECK_CB,
  MEMBERSHIP_VERIFY_FAILED_TEXT,
  MEMBERSHIP_GRANTED_TEXT,
} from "../src/bot/guards/channel-membership";
import { joinChannelKeyboard } from "../src/bot/keyboards";
import { registerMessageHandlers } from "../src/bot/handlers/messages";
import { registerCallbackHandlers } from "../src/bot/handlers/callbacks";
import { createMockAiService, type AiResult } from "../src/services/ollama";
import { TokenService } from "../src/bot/tokens";
import { TextCaptureFlow, type BotApp } from "../src/bot/context";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import type { ApiApp } from "../src/api/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOT_TOKEN = "123456:TEST-MEMB-TOKEN";
const ADMIN = 777;
const CUSTOMER = 555;

const CONFIG = loadConfig({
  BOT_TOKEN,
  ADMIN_IDS: String(ADMIN),
  APP_BASE_URL: "https://cafe.example.com",
});

let db: Db;

/** Per-test controllable membership statuses keyed by telegram user id. */
let chatMembers: Map<number, { status: string; is_member?: boolean }>;
let apiCalls: { chatId: string; userId: number }[];
let apiShouldThrow: boolean;

function attachFakeApi(membership: ChannelMembershipService): void {
  apiCalls = [];
  apiShouldThrow = false;
  membership.attach({
    getChatMember: async (chatId: string, userId: number) => {
      apiCalls.push({ chatId, userId });
      if (apiShouldThrow) {
        const err: any = new Error("Forbidden: bot is not a member of the chat");
        err.description = "Forbidden: bot is not a member of the chat";
        throw err;
      }
      const m = chatMembers.get(userId);
      if (!m) {
        const err: any = new Error("Bad Request: user not found");
        err.description = "Bad Request: user not found";
        throw err;
      }
      return m;
    },
  });
}

function buildBotApp(membership: ChannelMembershipService): BotApp {
  const businessHours = new BusinessHoursService(db, CONFIG.timezone);
  return {
    db,
    config: CONFIG,
    menu: new MenuService(db),
    cart: new CartService(db),
    orders: new OrdersService(db, businessHours),
    businessHours,
    ai: createMockAiService((): AiResult => ({
      type: "chat",
      reply: "ok",
      actions: [],
      needsClarification: false,
    })),
    tokens: new TokenService(db),
    history: new Map(),
    persona: "",
    customers: new CustomersService(db),
    loyalty: new LoyaltyService(db),
    notifications: new NotificationService(db),
    membership,
    profileEdit: new TextCaptureFlow(),
    depositFlow: new TextCaptureFlow(),
    rejectReasonFlow: new TextCaptureFlow(),
  };
}

function enableEnforcement(channel = "@my_cafe_channel", message = ""): void {
  updateMembershipSettings(db, { enabled: true, channel, message });
}

/** Fake grammY middleware runner: runs the guard, records whether next() ran. */
async function runGuard(
  app: BotApp,
  ctx: any,
): Promise<{ passed: boolean; replies: { text: string; opts?: any }[]; answers: any[]; edits: { text: string; opts?: any }[] }> {
  const replies: { text: string; opts?: any }[] = [];
  const answers: any[] = [];
  const edits: { text: string; opts?: any }[] = [];
  ctx.reply = ctx.reply ?? (async (t: string, opts?: any) => { replies.push({ text: t, opts }); return {}; });
  ctx.answerCallbackQuery = ctx.answerCallbackQuery ?? (async (o?: any) => { answers.push(o); return {}; });
  ctx.editMessageText = ctx.editMessageText ?? (async (t: string, opts?: any) => { edits.push({ text: t, opts }); return {}; });
  let passed = false;
  const guard = channelMembershipGuard(app);
  await guard(ctx, async () => {
    passed = true;
  });
  return { passed, replies, answers, edits };
}

function msgCtx(text: string, userId = CUSTOMER) {
  return {
    from: { id: userId, first_name: "Cust" },
    message: { text, message_id: 1 },
  };
}

function cbCtx(data: string, userId = CUSTOMER) {
  return {
    from: { id: userId, first_name: "Cust" },
    callbackQuery: { data },
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  chatMembers = new Map();
  apiCalls = [];
  apiShouldThrow = false;
  const menu = new MenuService(db);
  const cat = menu.createCategory({ name: "نوشیدنی" });
  menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 });
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
});

// ---------------------------------------------------------------------------
// Settings & normalization
// ---------------------------------------------------------------------------

describe("channel identifier normalization", () => {
  test("accepts @username, bare username, and public t.me links", () => {
    expect(normalizeChannel("@my_cafe_channel")).toBe("@my_cafe_channel");
    expect(normalizeChannel("my_cafe_channel")).toBe("@my_cafe_channel");
    expect(normalizeChannel("https://t.me/my_cafe_channel")).toBe("@my_cafe_channel");
    expect(normalizeChannel("http://t.me/my_cafe_channel/")).toBe("@my_cafe_channel");
    expect(normalizeChannel("t.me/my_cafe_channel")).toBe("@my_cafe_channel");
  });

  test("rejects invite links, too-short names, and garbage", () => {
    expect(normalizeChannel("https://t.me/+abcdef")).toBeNull();
    expect(normalizeChannel("https://t.me/joinchat/AAAA")).toBeNull();
    expect(normalizeChannel("@abc")).toBeNull(); // < 5 chars
    expect(normalizeChannel("")).toBeNull();
    expect(normalizeChannel(null)).toBeNull();
    expect(normalizeChannel("@12345")).toBeNull(); // must start with a letter
  });
});

describe("membership settings persistence", () => {
  test("defaults: disabled, no channel — customers are never blocked", () => {
    const s = getMembershipSettings(db);
    expect(s.enabled).toBe(false);
    expect(s.channel).toBeNull();
    expect(s.channelUrl).toBeNull();
    expect(s.message).toBe(DEFAULT_JOIN_MESSAGE);
    expect(s.messageIsDefault).toBe(true);
  });

  test("custom message is persisted; empty resets to default", () => {
    updateMembershipSettings(db, { channel: "@ch_aaa", message: "پیام سفارشی" });
    let s = getMembershipSettings(db);
    expect(s.message).toBe("پیام سفارشی");
    expect(s.messageIsDefault).toBe(false);
    updateMembershipSettings(db, { message: "" });
    s = getMembershipSettings(db);
    expect(s.message).toBe(DEFAULT_JOIN_MESSAGE);
    expect(s.messageIsDefault).toBe(true);
  });

  test("enabling without a valid channel is refused", () => {
    expect(() => updateMembershipSettings(db, { enabled: true })).toThrow();
    expect(() => updateMembershipSettings(db, { enabled: true, channel: "bad!" })).toThrow();
    expect(getMembershipSettings(db).enabled).toBe(false);
  });

  test("invalid channel identifier is refused", () => {
    expect(() => updateMembershipSettings(db, { channel: "https://t.me/+invite" })).toThrow();
    expect(getMembershipSettings(db).channel).toBeNull();
  });

  test("full roundtrip: enable with channel, then disable", () => {
    const saved = updateMembershipSettings(db, {
      enabled: true,
      channel: "https://t.me/my_cafe_channel",
      message: "عضو شوید",
    });
    expect(saved.enabled).toBe(true);
    expect(saved.channel).toBe("@my_cafe_channel");
    expect(saved.channelUrl).toBe("https://t.me/my_cafe_channel");
    const off = updateMembershipSettings(db, { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.channel).toBe("@my_cafe_channel"); // channel kept for re-enable
  });
});

// ---------------------------------------------------------------------------
// Status mapping (Telegram getChatMember semantics)
// ---------------------------------------------------------------------------

describe("ChatMember status mapping", () => {
  test("member statuses: creator, administrator, member", () => {
    expect(mapChatMemberStatus({ status: "creator" })).toBe("member");
    expect(mapChatMemberStatus({ status: "administrator" })).toBe("member");
    expect(mapChatMemberStatus({ status: "member" })).toBe("member");
  });

  test("non-member statuses: left, kicked", () => {
    expect(mapChatMemberStatus({ status: "left" })).toBe("not_member");
    expect(mapChatMemberStatus({ status: "kicked" })).toBe("not_member");
  });

  test("restricted counts as member only when is_member is true", () => {
    expect(mapChatMemberStatus({ status: "restricted", is_member: true })).toBe("member");
    expect(mapChatMemberStatus({ status: "restricted", is_member: false })).toBe("not_member");
    expect(mapChatMemberStatus({ status: "restricted" })).toBe("not_member");
  });

  test("unknown future status is never mapped to not_member", () => {
    expect(mapChatMemberStatus({ status: "something_new" })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// ChannelMembershipService.check
// ---------------------------------------------------------------------------

describe("ChannelMembershipService.check", () => {
  test("no configured channel -> unknown, no API call", async () => {
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    const r = await svc.check(CUSTOMER);
    expect(r.status).toBe("unknown");
    expect(apiCalls.length).toBe(0);
  });

  test("member is recorded and returned; the API is called with @channel and the user's id", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    chatMembers.set(CUSTOMER, { status: "member" });
    const r = await svc.check(CUSTOMER);
    expect(r.status).toBe("member");
    expect(apiCalls).toEqual([{ chatId: "@my_cafe_channel", userId: CUSTOMER }]);
    expect(svc.recordFor(CUSTOMER)).toMatchObject({ status: "member", channel: "@my_cafe_channel" });
  });

  test("left/kicked recorded as not_member", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    chatMembers.set(CUSTOMER, { status: "left" });
    expect((await svc.check(CUSTOMER)).status).toBe("not_member");
    chatMembers.set(CUSTOMER, { status: "kicked" });
    expect((await svc.check(CUSTOMER, { fresh: true })).status).toBe("not_member");
  });

  test("API failure -> unknown (persisted), never not_member", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    apiShouldThrow = true;
    const r = await svc.check(CUSTOMER);
    expect(r.status).toBe("unknown");
    expect(svc.recordFor(CUSTOMER)?.status).toBe("unknown");
  });

  test("second non-fresh check uses the cache (no extra API call)", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    chatMembers.set(CUSTOMER, { status: "member" });
    const first = await svc.check(CUSTOMER);
    const second = await svc.check(CUSTOMER);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(apiCalls.length).toBe(1);
  });

  test("fresh check bypasses the cache and re-queries Telegram", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    chatMembers.set(CUSTOMER, { status: "left" });
    await svc.check(CUSTOMER); // caches not_member
    // The customer joins the channel...
    chatMembers.set(CUSTOMER, { status: "member" });
    const stale = await svc.check(CUSTOMER);
    expect(stale.status).toBe("not_member"); // cache still stale
    const fresh = await svc.check(CUSTOMER, { fresh: true });
    expect(fresh.status).toBe("member");
    expect(fresh.fromCache).toBe(false);
    expect(apiCalls.length).toBe(2);
  });

  test("checked_at timestamp is persisted", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    attachFakeApi(svc);
    chatMembers.set(CUSTOMER, { status: "member" });
    await svc.check(CUSTOMER);
    const rec = svc.recordFor(CUSTOMER);
    expect(rec?.checkedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(rec!.checkedAt))).toBe(false);
  });

  test("no Telegram client attached -> unknown, not not_member", async () => {
    enableEnforcement();
    const svc = new ChannelMembershipService(db);
    const r = await svc.check(CUSTOMER);
    expect(r.status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Join keyboard
// ---------------------------------------------------------------------------

describe("join-channel keyboard", () => {
  test("opens the configured URL and offers the recheck button", () => {
    const kb = joinChannelKeyboard("https://t.me/my_cafe_channel");
    const json = JSON.stringify(kb);
    expect(json).toContain("https://t.me/my_cafe_channel");
    expect(json).toContain(MEMBERSHIP_RECHECK_CB);
    const flat = (kb as any).inline_keyboard.flat();
    const urlBtn = flat.find((b: any) => b.url);
    expect(urlBtn.url).toBe("https://t.me/my_cafe_channel");
  });
});

// ---------------------------------------------------------------------------
// Central guard behavior
// ---------------------------------------------------------------------------

describe("channelMembershipGuard", () => {
  test("1. disabled: customer text passes straight through", async () => {
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    const app = buildBotApp(membership);
    const r = await runGuard(app, msgCtx("سلام"));
    expect(r.passed).toBe(true);
    expect(r.replies.length).toBe(0);
    expect(apiCalls.length).toBe(0);
  });

  test("1b. enabled but no valid channel: still no blocking", async () => {
    // Enable flag without a channel is refused by updateMembershipSettings;
    // simulate drift by writing the setting directly.
    db.query("UPDATE settings SET value = '1' WHERE key = 'channel_membership_enabled'").run();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    const app = buildBotApp(membership);
    const r = await runGuard(app, msgCtx("سلام"));
    expect(r.passed).toBe(true);
  });

  test("2. a member is allowed through", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "member" });
    const app = buildBotApp(membership);
    const r = await runGuard(app, msgCtx("سلام"));
    expect(r.passed).toBe(true);
    expect(r.replies.length).toBe(0);
  });

  test("3. administrator and creator are treated as members", async () => {
    enableEnforcement();
    for (const status of ["administrator", "creator"]) {
      db.exec("DELETE FROM channel_membership");
      const membership = new ChannelMembershipService(db);
      attachFakeApi(membership);
      chatMembers.set(CUSTOMER, { status });
      const app = buildBotApp(membership);
      const r = await runGuard(app, msgCtx("سلام"));
      expect(r.passed, status).toBe(true);
    }
  });

  test("4. left/kicked users are restricted with the join prompt + keyboard", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const app = buildBotApp(membership);
    const r = await runGuard(app, msgCtx("سلام"));
    expect(r.passed).toBe(false);
    expect(r.replies.length).toBe(1);
    expect(r.replies[0]!.text).toBe(DEFAULT_JOIN_MESSAGE);
    const kb = JSON.stringify(r.replies[0]!.opts?.reply_markup);
    expect(kb).toContain("https://t.me/my_cafe_channel");
    expect(kb).toContain(MEMBERSHIP_RECHECK_CB);
  });

  test("5. restricted with is_member=true is allowed; is_member=false is blocked", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "restricted", is_member: true });
    expect((await runGuard(buildBotApp(membership), msgCtx("x"))).passed).toBe(true);
    // is_member=false is a different user so the cache does not interfere.
    chatMembers.set(666, { status: "restricted", is_member: false });
    expect((await runGuard(buildBotApp(membership), msgCtx("x", 666))).passed).toBe(false);
  });

  test("6. custom join message replaces the default", async () => {
    enableEnforcement("@my_cafe_channel", "پیام سفارشی مدیر");
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const r = await runGuard(buildBotApp(membership), msgCtx("سلام"));
    expect(r.replies[0]!.text).toBe("پیام سفارشی مدیر");
  });

  test("7+8. recheck is a fresh verification; joining after a block grants access", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const app = buildBotApp(membership);
    // Blocked initially.
    expect((await runGuard(app, msgCtx("سلام"))).passed).toBe(false);
    // The customer joins...
    chatMembers.set(CUSTOMER, { status: "member" });
    // ...and presses «عضو شدم، بررسی کن». The recheck must hit the API fresh.
    const callsBefore = apiCalls.length;
    const rc = await runGuard(app, cbCtx(MEMBERSHIP_RECHECK_CB));
    expect(rc.passed).toBe(false); // recheck itself never falls through
    expect(apiCalls.length).toBe(callsBefore + 1);
    const shown = [...rc.replies, ...rc.edits].map((x) => x.text).join("\n");
    expect(shown).toContain("تأیید شد");
    // The next interaction now passes without any extra recheck press.
    const after = await runGuard(app, msgCtx("سلام دوباره"));
    expect(after.passed).toBe(true);
  });

  test("recheck while still not a member keeps the restriction", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const app = buildBotApp(membership);
    const rc = await runGuard(app, cbCtx(MEMBERSHIP_RECHECK_CB));
    expect(rc.passed).toBe(false);
    expect(rc.answers.some((a) => a?.show_alert)).toBe(true);
    const after = await runGuard(app, msgCtx("سلام"));
    expect(after.passed).toBe(false);
  });

  test("9. API failure -> unknown state, retry-friendly message, NOT a non-member claim", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    apiShouldThrow = true;
    const app = buildBotApp(membership);
    const r = await runGuard(app, msgCtx("سلام"));
    expect(r.passed).toBe(false); // fail-closed: access withheld until verified
    expect(r.replies.length).toBe(1);
    expect(r.replies[0]!.text).toContain("ممکن نیست");
    expect(r.replies[0]!.text).not.toBe(DEFAULT_JOIN_MESSAGE);
    // Persisted as unknown, not not_member.
    expect(membership.recordFor(CUSTOMER)?.status).toBe("unknown");
  });

  test("10. callback actions cannot bypass the guard", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const app = buildBotApp(membership);
    for (const data of ["co", "cart", "m", "cats", "pm:c", "wdep"]) {
      const r = await runGuard(app, cbCtx(data));
      expect(r.passed, data).toBe(false);
      expect(r.answers.some((a) => a?.show_alert), data).toBe(true);
    }
    // Cart untouched.
    expect(app.cart.getTotals(CUSTOMER).lines.length).toBe(0);
  });

  test("11. administrators are exempt even when not channel members", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    // Admin never appears in chatMembers — if the guard queried, it would throw.
    const app = buildBotApp(membership);
    const r = await runGuard(app, msgCtx("سلام", ADMIN));
    expect(r.passed).toBe(true);
    expect(apiCalls.length).toBe(0); // not even queried
    // Admin callbacks also pass.
    const cb = await runGuard(app, cbCtx("oa:yes:1", ADMIN));
    expect(cb.passed).toBe(true);
  });

  test("updates without a user pass through", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    const app = buildBotApp(membership);
    const r = await runGuard(app, { message: { text: "channel post" } });
    expect(r.passed).toBe(true);
  });

  test("the guard only ever checks ctx.from.id — never callback-supplied ids", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "member" });
    chatMembers.set(99999, { status: "left" });
    const app = buildBotApp(membership);
    // A member presses a callback; even if callback data tried to name
    // another user (it can't — data is opaque), only 555 is verified.
    const r = await runGuard(app, { ...cbCtx("ch:check:99999"), from: { id: CUSTOMER } });
    // "ch:check:99999" is not the exact recheck action, so it is treated as a
    // regular callback: 555 (member) passes, 99999 is never queried.
    expect(r.passed).toBe(true);
    expect(apiCalls.every((c) => c.userId === CUSTOMER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard + real handlers: customer flows stay intact
// ---------------------------------------------------------------------------

function fakeBot() {
  const commands = new Map<string, (ctx: any) => Promise<void>>();
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  return {
    command(name: string, h: (ctx: any) => Promise<void>) {
      commands.set(name, h);
    },
    on(event: string, h: (ctx: any) => Promise<void>) {
      handlers.set(event, h);
    },
    _commands: commands,
    _handlers: handlers,
  };
}

function fakeCtx(text: string, userId = CUSTOMER) {
  const replies: { text: string; opts?: any }[] = [];
  return {
    from: { id: userId, first_name: "Cust" },
    message: { text, message_id: 1 },
    reply: async (t: string, opts?: any) => {
      replies.push({ text: t, opts });
      return {} as any;
    },
    _replies: replies,
  };
}

/** Run the guard first, then the real message handler — like grammY does. */
async function guardedText(app: BotApp, bot: any, text: string, userId = CUSTOMER) {
  const ctx = fakeCtx(text, userId);
  const guard = channelMembershipGuard(app);
  let passed = false;
  await guard(ctx as any, async () => {
    passed = true;
  });
  if (passed) {
    await bot._handlers.get("message:text")!(ctx);
  }
  return { passed, ctx };
}

describe("guard + real handlers integration", () => {
  test("14. with the feature disabled, ordering/text flows are untouched", async () => {
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    const app = buildBotApp(membership);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const { passed, ctx } = await guardedText(app, bot, "سلام");
    expect(passed).toBe(true);
    expect(ctx._replies.length).toBe(1); // AI mock replied
  });

  test("a blocked member's text never reaches the AI handler", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const app = buildBotApp(membership);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const { passed, ctx } = await guardedText(app, bot, "دو تا آب اضافه کن");
    expect(passed).toBe(false);
    // Only the join prompt — no AI reply, no cart mutation.
    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]!.text).toBe(DEFAULT_JOIN_MESSAGE);
    expect(app.cart.getTotals(CUSTOMER).lines.length).toBe(0);
  });

  test("a member's text reaches the handlers normally", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "member" });
    const app = buildBotApp(membership);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const { passed, ctx } = await guardedText(app, bot, "سلام");
    expect(passed).toBe(true);
    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]!.text).toBe("ok");
  });

  test("a blocked non-member cannot press checkout via callbacks", async () => {
    enableEnforcement();
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    chatMembers.set(CUSTOMER, { status: "left" });
    const app = buildBotApp(membership);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const prod = menu.listProducts(cat.id, false)[0]!;
    app.cart.addItem(CUSTOMER, prod.id, null, 1); // seeded outside the guard

    const answers: any[] = [];
    const ctx = {
      from: { id: CUSTOMER },
      callbackQuery: { data: "co" },
      answerCallbackQuery: async (o?: any) => {
        answers.push(o);
        return {} as any;
      },
      reply: async () => ({}) as any,
      editMessageText: async () => ({}) as any,
    };
    const guard = channelMembershipGuard(app);
    let passed = false;
    await guard(ctx as any, async () => {
      passed = true;
      await bot._handlers.get("callback_query")!(ctx);
    });
    expect(passed).toBe(false);
    // Checkout never started.
    expect(app.cart.get(CUSTOMER)?.state).toBe("browsing");
    expect(answers.some((a) => a?.show_alert)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin API: settings, status, manual recheck, authorization
// ---------------------------------------------------------------------------

describe("admin API: channel membership", () => {
  let apiApp: ApiApp;
  const NOW_S = () => Math.floor(Date.now() / 1000);
  const ADMIN_USER = { id: ADMIN, first_name: "Admin" };
  const OTHER_USER = { id: 999, first_name: "Bob" };

  function headersFor(user: typeof ADMIN_USER | typeof OTHER_USER): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-telegram-init-data": signInitData(BOT_TOKEN, user as any, NOW_S()),
    };
  }

  function call(
    method: string,
    path: string,
    opts: { user?: typeof ADMIN_USER | typeof OTHER_USER | null; body?: unknown } = {},
  ) {
    const user = opts.user === undefined ? ADMIN_USER : opts.user;
    const headers = user ? headersFor(user) : {};
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    return handleAdminApi(new Request(`http://localhost${path}`, { method, headers, body }), apiApp).then(
      async (r) => ({ status: r!.status, body: await r!.json() }),
    );
  }

  beforeEach(() => {
    const businessHours = new BusinessHoursService(db, CONFIG.timezone);
    const menu = new MenuService(db);
    const orders = new OrdersService(db, businessHours);
    const notifications = new NotificationService(db);
    const membership = new ChannelMembershipService(db);
    attachFakeApi(membership);
    apiApp = {
      config: CONFIG,
      db,
      menu,
      orders,
      businessHours,
      reports: null as any,
      notifications,
      uploadsDir: mkdtempSync(join(tmpdir(), "cafe-uploads-")),
      customers: new CustomersService(db),
      loyalty: new LoyaltyService(db),
      membership,
    };
  });

  test("GET settings returns defaults", async () => {
    const r = await call("GET", "/api/admin/settings/channel-membership");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false, channel: "", channelUrl: null });
  });

  test("PUT settings saves channel + message; validation errors return 400", async () => {
    const ok = await call("PUT", "/api/admin/settings/channel-membership", {
      body: { enabled: true, channel: "@my_cafe_channel", message: "عضو شوید" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      enabled: true,
      channel: "@my_cafe_channel",
      channelUrl: "https://t.me/my_cafe_channel",
      message: "عضو شوید",
    });

    const bad = await call("PUT", "/api/admin/settings/channel-membership", {
      body: { channel: "https://t.me/+invite" },
    });
    expect(bad.status).toBe(400);

    const enableNoChannel = await call("PUT", "/api/admin/settings/channel-membership", {
      body: { enabled: true, channel: "" },
    });
    expect(enableNoChannel.status).toBe(400);
  });

  test("13. non-admin cannot read or change membership settings", async () => {
    const read = await call("GET", "/api/admin/settings/channel-membership", { user: OTHER_USER });
    expect(read.status).toBe(403);
    const write = await call("PUT", "/api/admin/settings/channel-membership", {
      user: OTHER_USER,
      body: { enabled: true, channel: "@evil_channel" },
    });
    expect(write.status).toBe(403);
    expect(getMembershipSettings(db).enabled).toBe(false);
  });

  test("13b. non-admin cannot inspect customers or trigger checks", async () => {
    const list = await call("GET", "/api/admin/customers", { user: OTHER_USER });
    expect(list.status).toBe(403);
    const detail = await call("GET", `/api/admin/customers/${CUSTOMER}`, { user: OTHER_USER });
    expect(detail.status).toBe(403);
    const check = await call("POST", `/api/admin/customers/${CUSTOMER}/membership-check`, {
      user: OTHER_USER,
      body: {},
    });
    expect(check.status).toBe(403);
  });

  test("12. manual admin check persists status + timestamp; failure is unknown", async () => {
    updateMembershipSettings(db, { channel: "@my_cafe_channel", enabled: true });
    apiApp.customers.saveProfile(CUSTOMER, { fullName: "مشتری" });

    chatMembers.set(CUSTOMER, { status: "member" });
    const r1 = await call("POST", `/api/admin/customers/${CUSTOMER}/membership-check`, { body: {} });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("member");
    expect(r1.body.statusLabel).toBe("عضو کانال");
    expect(r1.body.checkedAt).toBeTruthy();

    // Fresh check reflects the new reality after the user leaves.
    chatMembers.set(CUSTOMER, { status: "left" });
    const r2 = await call("POST", `/api/admin/customers/${CUSTOMER}/membership-check`, { body: {} });
    expect(r2.body.status).toBe("not_member");

    // Telegram outage: unknown, explicitly NOT not_member.
    apiShouldThrow = true;
    const r3 = await call("POST", `/api/admin/customers/${CUSTOMER}/membership-check`, { body: {} });
    expect(r3.body.status).toBe("unknown");
    expect(r3.body.statusLabel).toBe("بررسی ناموفق");

    // Without a configured channel the check is refused.
    db.query("UPDATE settings SET value = '' WHERE key = 'channel_membership_channel'").run();
    const r4 = await call("POST", `/api/admin/customers/${CUSTOMER}/membership-check`, { body: {} });
    expect(r4.status).toBe(400);
  });

  test("customer list carries cached membership and supports filtering", async () => {
    updateMembershipSettings(db, { channel: "@my_cafe_channel", enabled: true });
    apiApp.customers.saveProfile(555, { fullName: "الف" });
    apiApp.customers.saveProfile(666, { fullName: "ب" });
    apiApp.customers.saveProfile(778, { fullName: "ج" });
    apiApp.customers.recordSender(555, { firstName: "الف" });
    apiApp.customers.recordSender(666, { firstName: "ب" });
    apiApp.customers.recordSender(778, { firstName: "ج" });

    // 555 member, 666 not_member, 778 never checked.
    chatMembers.set(555, { status: "member" });
    chatMembers.set(666, { status: "left" });
    await apiApp.membership.check(555);
    await apiApp.membership.check(666);

    const all = await call("GET", "/api/admin/customers");
    expect(all.status).toBe(200);
    const allRows = all.body as any[];
    const byId = new Map(allRows.map((c: any) => [c.id, c]));
    expect(byId.get(555).membership.status).toBe("member");
    expect(byId.get(555).membership.statusLabel).toBe("عضو کانال");
    expect(byId.get(666).membership.status).toBe("not_member");
    expect(byId.get(778).membership).toBeNull();

    const members = await call("GET", "/api/admin/customers?membership=member");
    expect(members.body.every((c: any) => c.membership?.status === "member")).toBe(true);
    expect(members.body.some((c: any) => c.id === 555)).toBe(true);

    const nonMembers = await call("GET", "/api/admin/customers?membership=not_member");
    expect(nonMembers.body.map((c: any) => c.id)).toEqual([666]);

    const none = await call("GET", "/api/admin/customers?membership=none");
    expect(none.body.some((c: any) => c.id === 778)).toBe(true);
    expect(none.body.some((c: any) => c.id === 555)).toBe(false);

    const bad = await call("GET", "/api/admin/customers?membership=whatever");
    expect(bad.status).toBe(400);
  });

  test("customer detail exposes membership with Persian labels and never-checked state", async () => {
    updateMembershipSettings(db, { channel: "@my_cafe_channel", enabled: true });
    apiApp.customers.saveProfile(CUSTOMER, { fullName: "مشتری" });

    // Never checked.
    let d = await call("GET", `/api/admin/customers/${CUSTOMER}`);
    expect(d.body.membership.status).toBeNull();
    expect(d.body.membership.statusLabel).toBe("هنوز بررسی نشده");
    expect(d.body.membership.configuredChannel).toBe("@my_cafe_channel");

    chatMembers.set(CUSTOMER, { status: "administrator" });
    await apiApp.membership.check(CUSTOMER);
    d = await call("GET", `/api/admin/customers/${CUSTOMER}`);
    expect(d.body.membership.status).toBe("member");
    expect(d.body.membership.statusLabel).toBe("عضو کانال");
    expect(d.body.membership.checkedAt).toBeTruthy();
  });
});
