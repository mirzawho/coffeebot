import { describe, test, expect, beforeEach } from "bun:test";
import { withTypingIndicator } from "../src/bot/typing";
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
    const r = await withTypingIndicator(ctx as any, work, 10);
    expect(r).toBe("result");
    expect(done).toBe(true);
    expect(ctx._actions[0]).toBe("typing");
  });

  test("refreshes during a long-running operation", async () => {
    const ctx = typingCtx();
    await withTypingIndicator(ctx as any, Bun.sleep(45), 10);
    // initial + at least two refreshes (t=0,10,20,... while work lasts 45ms)
    expect(ctx._actions.length).toBeGreaterThanOrEqual(3);
  });

  test("stops refreshing after the work completes (no timer leak)", async () => {
    const ctx = typingCtx();
    await withTypingIndicator(ctx as any, Bun.sleep(5), 10);
    const after = ctx._actions.length;
    await Bun.sleep(40); // several intervals after completion
    expect(ctx._actions.length).toBe(after);
  });

  test("stops after the work rejects (cleanup on exceptions)", async () => {
    const ctx = typingCtx();
    const work = Promise.reject(new Error("boom"));
    try {
      await withTypingIndicator(ctx as any, work, 10);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toBe("boom");
    }
    const after = ctx._actions.length;
    await Bun.sleep(30);
    expect(ctx._actions.length).toBe(after);
    expect(ctx._actions[0]).toBe("typing");
  });

  test("typing-action failure does not block the response", async () => {
    const ctx = typingCtx();
    ctx.replyWithChatAction = async () => {
      throw new Error("telegram down");
    };
    const r = await withTypingIndicator(ctx as any, Promise.resolve("ok"), 10);
    expect(r).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Integration: handler wiring (typing + single final reply through the real path)
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
    fulfillmentTimeFlow: new TextCaptureFlow(),
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

describe("handler wiring (typing + single reply)", () => {
  test("an AI-bound text message triggers the typing indicator", async () => {
    app = buildApp({ type: "chat", reply: "سلام!", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = textCtx("سلام، خوبی؟");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._actions).toEqual(["typing"]);
    expect(ctx._replies[0]!.text).toContain("سلام!");
  });

  test("a valid structured response produces exactly one plain-text reply", async () => {
    app = buildApp({ type: "chat", reply: "پاسخ ساده", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = textCtx("سلام");
    await bot._handlers.get("message:text")!(ctx);
    // Exactly one final message; no edits; no raw JSON anywhere.
    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]!.text).toBe("پاسخ ساده");
    expect(ctx._replies[0]!.text).not.toContain("{");
    expect(ctx._replies[0]!.text).not.toContain('"type"');
    expect(ctx._edits.length).toBe(0);
  });

  test("the AiInput carries no streaming callback (non-streaming provider mode)", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    await bot._handlers.get("message:text")!(textCtx("سلام"));
    expect(aiInputs.length).toBe(1);
    expect((aiInputs[0] as any).onDelta).toBeUndefined();
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

  test("conversation history records the validated reply, never raw JSON", async () => {
    app = buildApp({ type: "chat", reply: "پاسخ نهایی", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    await bot._handlers.get("message:text")!(textCtx("سلام"));
    const history = app.history.get(555) ?? [];
    expect(history.at(-1)).toEqual({ role: "assistant", content: "پاسخ نهایی" });
  });
});
