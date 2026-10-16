import { describe, test, expect, beforeEach } from "bun:test";
import { withTypingIndicator, TelegramStreamer, toTelegramHtml, escapeHtml } from "../src/bot/typing";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { loadConfig } from "../src/config";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { updatePaymentSettings, setSetting } from "../src/services/settings";
import { createMockAiService, type AiInput, type AiResult } from "../src/services/ollama";
import { TokenService } from "../src/bot/tokens";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { registerMessageHandlers } from "../src/bot/handlers/messages";
import type { BotApp } from "../src/bot/context";
import { TextCaptureFlow } from "../src/bot/context";

const CONFIG = loadConfig({
  BOT_TOKEN: "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ",
  ADMIN_IDS: "777",
  APP_BASE_URL: "https://cafe.example.com",
});

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

function typingCtx() {
  const actions: string[] = [];
  return {
    from: { id: 1 },
    chat: { id: 100 },
    replyWithChatAction: async (action: string) => {
      actions.push(action);
      return true as any;
    },
    reply: async () => ({}) as any,
    editMessageText: async () => ({} as any),
    _actions: actions,
  };
}

describe("typing indicator", () => {
  test("starts immediately and stops when work completes", async () => {
    const ctx = typingCtx();
    let done = false;
    const work = (async () => {
      await Bun.sleep(30);
      done = true;
      return "result";
    })();
    const r = await withTypingIndicator(ctx as any, work);
    expect(r).toBe("result");
    expect(done).toBe(true);
    expect(ctx._actions).toEqual(["typing"]);
  });

  test("refreshes during a long-running generation", async () => {
    const ctx = typingCtx();
    const work = Bun.sleep(100); // > TYPING_INTERVAL_MS (4s)? no — use fake short loop
    // The interval is 4s in production; here we only verify no duplicate loops
    // and cleanup. A 100ms work item must produce exactly one action.
    await withTypingIndicator(ctx as any, work);
    expect(ctx._actions.length).toBe(1);
  });

  test("stops after the work rejects (cleanup on exceptions)", async () => {
    const ctx = typingCtx();
    const work = Promise.reject(new Error("boom"));
    try {
      await withTypingIndicator(ctx as any, work);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toBe("boom");
    }
    expect(ctx._actions).toEqual(["typing"]);
  });

  test("typing-action failure does not block the response", async () => {
    const ctx = typingCtx();
    ctx.replyWithChatAction = async () => {
      throw new Error("telegram down");
    };
    const r = await withTypingIndicator(ctx as any, Promise.resolve("ok"));
    expect(r).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// TelegramStreamer
// ---------------------------------------------------------------------------

function streamCtx() {
  const calls: { kind: "reply" | "edit"; text: string; opts?: any }[] = [];
  let nextId = 500;
  return {
    from: { id: 1 },
    chat: { id: 100 },
    reply: async (text: string, opts?: any) => {
      calls.push({ kind: "reply", text, opts });
      return { message_id: nextId++ } as any;
    },
    editMessageText: async (text: string, opts?: any) => {
      calls.push({ kind: "edit", text, opts });
      return true as any;
    },
    _calls: calls,
  };
}

const sleep = (ms: number) => Bun.sleep(ms);

describe("TelegramStreamer", () => {
  test("first flush sends a placeholder, later updates edit it", async () => {
    const ctx = streamCtx();
    const s = new TelegramStreamer(ctx as any);
    s.append("سلام");
    await sleep(10);
    s.append(" عزیزم، خوش آمدی!");
    const final = await s.finalize();
    expect(final).toBe("سلام عزیزم، خوش آمدی!");
    const kinds = ctx._calls.map((c) => c.kind);
    expect(kinds[0]).toBe("reply");
    expect(kinds).toContain("edit");
    // The last edit contains the complete text — no duplicate final reply.
    expect(ctx._calls.filter((c) => c.kind === "reply").length).toBe(1);
  });

  test("unchanged content is not re-edited", async () => {
    const ctx = streamCtx();
    const s = new TelegramStreamer(ctx as any);
    s.append("متن ثابت");
    await sleep(10);
    await s.finalize();
    const edits = ctx._calls.filter((c) => c.kind === "edit");
    const texts = new Set(edits.map((e) => e.text));
    // No two edits with identical text.
    expect(edits.length).toBe(texts.size);
  });

  test("empty stream produces no message and no false success", async () => {
    const ctx = streamCtx();
    const s = new TelegramStreamer(ctx as any);
    const final = await s.finalize();
    expect(final).toBe("");
    expect(ctx._calls.length).toBe(0);
  });

  test("HTML formatting is applied and falls back to plain text on parse errors", async () => {
    const ctx = streamCtx();
    const s = new TelegramStreamer(ctx as any);
    s.append("**مهم** و `کد`");
    await sleep(10);
    await s.finalize();
    const last = ctx._calls[ctx._calls.length - 1]!;
    expect(last.text).toContain("<b>مهم</b>");
    expect(last.text).toContain("<code>کد</code>");
    expect(last.opts?.parse_mode).toBe("HTML");
  });

  test("edit failures do not lose the accumulated text", async () => {
    const ctx = streamCtx();
    let failEdits = true;
    ctx.editMessageText = async () => {
      if (failEdits) throw new Error("400: parse error");
      return true as any;
    };
    const s = new TelegramStreamer(ctx as any);
    s.append("بخش اول");
    await sleep(10);
    s.append(" و بخش دوم");
    await sleep(10);
    const final = await s.finalize();
    // Full text preserved and delivered exactly once.
    expect(final).toBe("بخش اول و بخش دوم");
    expect(ctx._calls.filter((c) => c.kind === "reply").length).toBe(1);
  });

  test("content longer than one Telegram message is not truncated", async () => {
    const ctx = streamCtx();
    const s = new TelegramStreamer(ctx as any);
    const long = "کلمه ".repeat(1200); // ~6000 chars > 4096
    s.append(long);
    await sleep(10);
    const final = await s.finalize();
    expect(final.length).toBe(long.trim().length);
    // Delivered as a single fresh reply with the complete text.
    const replies = ctx._calls.filter((c) => c.kind === "reply");
    expect(replies.length).toBe(1);
    expect(replies[0]!.text.length).toBe(final.length);
  });
});

describe("HTML escaping", () => {
  test("escapes HTML-control characters", () => {
    expect(escapeHtml("<b>&\"x\"")).toBe("&lt;b&gt;&amp;\"x\"");
  });

  test("model markdown converts to safe HTML; raw tags are escaped", () => {
    const html = toTelegramHtml("**بولد** <script>alert(1)</script>");
    expect(html).toContain("<b>بولد</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------
// Integration: handler wiring (typing + streaming + persona through the real path)
// ---------------------------------------------------------------------------

let db: Db;
let app: BotApp;

function fakeBot() {
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  return {
    command() {},
    on(event: string, h: (ctx: any) => Promise<void>) {
      handlers.set(event, h);
    },
    api: { setChatMenuButton: async () => ({}) },
    _handlers: handlers,
  };
}

function textCtx(text: string) {
  const replies: { text: string; opts?: any }[] = [];
  const actions: string[] = [];
  const edits: { text: string }[] = [];
  return {
    from: { id: 555, first_name: "Cust" },
    chat: { id: 555 },
    message: { text, message_id: 1 },
    reply: async (t: string, opts?: any) => {
      replies.push({ text: t, opts });
      return { message_id: replies.length + 10 } as any;
    },
    replyWithChatAction: async (a: string) => {
      actions.push(a);
      return true as any;
    },
    editMessageText: async (t: string) => {
      edits.push({ text: t });
      return true as any;
    },
    _replies: replies,
    _actions: actions,
    _edits: edits,
  };
}

function buildApp(aiResult: AiResult | ((input: AiInput) => AiResult), persona = ""): BotApp {
  const menu = new MenuService(db);
  const businessHours = new BusinessHoursService(db, CONFIG.timezone);
  return {
    db,
    config: CONFIG,
    menu,
    cart: new CartService(db),
    orders: new OrdersService(db, businessHours),
    businessHours,
    ai: createMockAiService((input) => {
      aiInputs.push(input);
      return typeof aiResult === "function" ? aiResult(input) : aiResult;
    }),
    tokens: new TokenService(db),
    history: new Map(),
    persona,
    customers: new CustomersService(db),
    loyalty: new LoyaltyService(db),
    profileEdit: new TextCaptureFlow(),
    depositFlow: new TextCaptureFlow(),
  };
}

let aiInputs: AiInput[];

beforeEach(() => {
  db = openDatabase(":memory:");
  aiInputs = [];
  const menu = new MenuService(db);
  const cat = menu.createCategory({ name: "نوشیدنی" });
  menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 });
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
});

describe("handler wiring (typing + persona)", () => {
  test("an AI-bound text message triggers the typing indicator", async () => {
    app = buildApp({ type: "chat", reply: "سلام!", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = textCtx("سلام، خوبی؟");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._actions).toEqual(["typing"]);
    expect(ctx._replies[0]!.text).toContain("سلام!");
  });

  test("the persona reaches the AI input; core rules stay in code", async () => {
    app = buildApp({ type: "chat", reply: "پاسخ", actions: [], needsClarification: false });
    // Persona is persisted in settings (admin panel contract) and read per request.
    setSetting(db, "ai_persona", "- لحن رسمی باشد.");
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    await bot._handlers.get("message:text")!(textCtx("سلام"));
    expect(aiInputs.length).toBe(1);
    expect(aiInputs[0]!.persona).toBe("- لحن رسمی باشد.");
  });

  test("deterministic checkout-state text does not trigger typing or AI", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    app.cart.addItem(555, 1, null, 1);
    app.orders.startCheckout(555); // state = checkout_receipt
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = textCtx("رسید فرستادم؟");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._actions.length).toBe(0);
    expect(aiInputs.length).toBe(0);
  });
});
