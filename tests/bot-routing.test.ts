import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { loadConfig } from "../src/config";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { updatePaymentSettings } from "../src/services/settings";
import {
  createMockAiService,
  createDisabledAiService,
  createAiService,
  AI_DISABLED_REPLY,
  AI_UNAVAILABLE_REPLY,
  type AiInput,
  type AiResult,
} from "../src/services/ollama";
import { TokenService } from "../src/bot/tokens";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { registerMessageHandlers } from "../src/bot/handlers/messages";
import { registerCallbackHandlers } from "../src/bot/handlers/callbacks";
import { registerAdminEntry, adminWebAppUrl, adminEntryKeyboard } from "../src/bot/admin-entry";
import type { BotApp } from "../src/bot/context";
import { TextCaptureFlow } from "../src/bot/context";

/**
 * Minimal grammY Bot stand-in that records registered handlers so we can drive
 * the real message/admin handlers without a network or a Telegram token.
 */
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
    api: {
      setChatMenuButton: async () => ({ ok: true, result: true }),
    },
    _commands: commands,
    _handlers: handlers,
  };
}

function fakeCtx(
  text: string,
  from: Record<string, unknown> = {
    id: 555,
    username: "customer",
    first_name: "Cust",
    last_name: null,
    language_code: "fa",
  },
) {
  const replies: { text: string; opts?: any }[] = [];
  return {
    from,
    message: { text, message_id: 1 },
    reply: async (t: string, opts?: any) => {
      replies.push({ text: t, opts });
      return {} as any;
    },
    _replies: replies,
  };
}

const CONFIG = loadConfig({
  BOT_TOKEN: "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ",
  ADMIN_IDS: "777",
  APP_BASE_URL: "https://cafe.example.com",
});

let db: Db;
let app: BotApp;
let waterId: number;
let aiInputs: AiInput[];

function buildApp(aiResult: AiResult | ((input: AiInput) => AiResult)): BotApp {
  const menu = new MenuService(db);
  const businessHours = new BusinessHoursService(db, CONFIG.timezone);
  const cart = new CartService(db);
  const orders = new OrdersService(db, businessHours);
  return {
    db,
    config: CONFIG,
    menu,
    cart,
    orders,
    businessHours,
    ai: createMockAiService((input) => {
      aiInputs.push(input);
      return typeof aiResult === "function" ? aiResult(input) : aiResult;
    }),
    tokens: new TokenService(db),
    history: new Map(),
    persona: "",
    customers: new CustomersService(db),
    loyalty: new LoyaltyService(db),
    profileEdit: new TextCaptureFlow(),
    depositFlow: new TextCaptureFlow(),
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  aiInputs = [];
  const menu = new MenuService(db);
  const cat = menu.createCategory({ name: "نوشیدنی" });
  waterId = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 }).id;
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
});

describe("AI conversational path (regression: bot must use the model for normal messages)", () => {
  test("a normal free-form message reaches the AI and the model text is sent to Telegram", async () => {
    const modelReply = "ما هر روز از ساعت ۸ تا ۲۲ باز هستیم.";
    app = buildApp({ type: "chat", reply: modelReply, actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("تا کی باز هستید؟");
    await bot._handlers.get("message:text")!(ctx);

    // The AI was actually consulted...
    expect(aiInputs.length).toBe(1);
    expect(aiInputs[0]!.message).toBe("تا کی باز هستید؟");
    // ...and the model-generated text was delivered to the customer.
    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]!.text).toContain(modelReply);
  });

  test("the AI receives the current business hours as context", async () => {
    app = buildApp({ type: "chat", reply: "ok", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    await bot._handlers.get("message:text")!(fakeCtx("سلام"));

    expect(aiInputs[0]!.businessHours).toBeDefined();
    expect(aiInputs[0]!.businessHours!.length).toBe(7);
  });

  test("a cart_action reply applies the validated action and still sends the model text", async () => {
    app = buildApp({
      type: "cart_action",
      reply: "یک آب اضافه شد.",
      actions: [{ type: "add", productId: waterId, variantId: null, quantity: 2 }],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("دو تا آب اضافه کن");
    await bot._handlers.get("message:text")!(ctx);

    expect(app.cart.getTotals(555).lines.length).toBe(1);
    expect(app.cart.getTotals(555).lines[0]!.quantity).toBe(2);
    expect(ctx._replies[0]!.text).toContain("یک آب اضافه شد.");
  });

  test("conversation history is recorded for follow-up turns", async () => {
    app = buildApp({ type: "chat", reply: "پاسخ مدل", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    await bot._handlers.get("message:text")!(fakeCtx("سلام"));

    const history = app.history.get(555)!;
    expect(history.length).toBe(2);
    expect(history[0]).toEqual({ role: "user", content: "سلام" });
    expect(history[1]).toEqual({ role: "assistant", content: "پاسخ مدل" });
  });

  test("an AI failure falls back to the deterministic fallback text", async () => {
    app = buildApp(() => {
      throw new Error("network down");
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("سلام");
    await bot._handlers.get("message:text")!(ctx);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]!.text.length).toBeGreaterThan(0);
  });
});

describe("identity routing through the bot", () => {
  test("an identity question is answered deterministically without calling the AI", async () => {
    app = buildApp({ type: "chat", reply: "should not be used", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("آیدی تلگرام من چنده؟");
    await bot._handlers.get("message:text")!(ctx);

    expect(aiInputs.length).toBe(0);
    expect(ctx._replies[0]!.text).toContain("555");
  });

  test("/whoami replies with the trusted sender id", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("/whoami");
    await bot._commands.get("whoami")!(ctx);

    expect(ctx._replies[0]!.text).toContain("555");
    expect(aiInputs.length).toBe(0);
  });

  test("commands are not double-handled by the text handler", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("/whoami");
    await bot._handlers.get("message:text")!(ctx);

    expect(ctx._replies.length).toBe(0);
    expect(aiInputs.length).toBe(0);
  });
});

describe("callback token dedup through the bot", () => {
  test("a double-pressed add callback applies the item only once", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);

    const token = app.tokens.mint(555, `a:${waterId}:0`);
    const data = `a:${waterId}:0:${token}`;
    const makeCtx = () => {
      const answers: any[] = [];
      return {
        from: { id: 555 },
        callbackQuery: { data },
        answerCallbackQuery: async (o?: any) => {
          answers.push(o);
          return {} as any;
        },
        reply: async () => ({}) as any,
        editMessageText: async () => ({}) as any,
        _answers: answers,
      };
    };

    const first = makeCtx();
    await bot._handlers.get("callback_query")!(first);
    const second = makeCtx();
    await bot._handlers.get("callback_query")!(second);

    // Only the first press mutated the cart.
    expect(app.cart.getTotals(555).lines.length).toBe(1);
    expect(app.cart.getTotals(555).lines[0]!.quantity).toBe(1);
    // The second press was rejected as already-applied.
    expect(second._answers.some((a) => a?.text?.includes("قبلاً"))).toBe(true);
  });
});

describe("admin entry point", () => {
  test("adminWebAppUrl normalizes the origin to a root URL", () => {
    expect(adminWebAppUrl("https://cafe.example.com")).toBe("https://cafe.example.com/");
    expect(adminWebAppUrl("https://cafe.example.com/")).toBe("https://cafe.example.com/");
  });

  test("adminEntryKeyboard contains a web_app button pointing at the Mini App", () => {
    const kb = adminEntryKeyboard("https://cafe.example.com");
    const json = JSON.stringify(kb);
    expect(json).toContain("web_app");
    expect(json).toContain("https://cafe.example.com/");
  });

  test("a non-admin gets a neutral refusal and no keyboard", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerAdminEntry(bot as any, app);

    const ctx = fakeCtx("/admin", { id: 555, username: "customer" });
    await bot._commands.get("admin")!(ctx);

    expect(ctx._replies[0]!.text).toContain("مدیران");
    expect(ctx._replies[0]!.opts?.reply_markup).toBeUndefined();
  });

  test("an admin gets the Mini App button", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerAdminEntry(bot as any, app);

    const ctx = fakeCtx("/admin", { id: 777, username: "owner" });
    await bot._commands.get("admin")!(ctx);

    expect(ctx._replies[0]!.opts?.reply_markup).toBeDefined();
    expect(JSON.stringify(ctx._replies[0]!.opts!.reply_markup)).toContain("https://cafe.example.com/");
  });
});

// ---------------------------------------------------------------------------
// Conversational ordering: product offers, intents, and the full checkout flow
// ---------------------------------------------------------------------------

function makeCallbackCtx(data: string, userId = 555) {
  const answers: any[] = [];
  const replies: { text: string; opts?: any }[] = [];
  const edits: { text: string; opts?: any }[] = [];
  return {
    from: { id: userId, first_name: "Cust" },
    callbackQuery: { data },
    answerCallbackQuery: async (o?: any) => {
      answers.push(o);
      return {} as any;
    },
    reply: async (t: string, opts?: any) => {
      replies.push({ text: t, opts });
      return {} as any;
    },
    editMessageText: async (t: string, opts?: any) => {
      edits.push({ text: t, opts });
      return {} as any;
    },
    _answers: answers,
    _replies: replies,
    _edits: edits,
  };
}

function makeMediaCtx(kind: "photo" | "document", userId = 555, extra: Record<string, unknown> = {}) {
  const replies: { text: string; opts?: any }[] = [];
  const message: Record<string, unknown> = { message_id: 42, ...extra };
  if (kind === "photo") {
    message.photo = [
      { file_id: "small", file_size: 100 },
      { file_id: "receipt-file", file_size: 2048 },
    ];
  } else {
    message.document = { file_id: "doc-file", file_size: 2048, mime_type: "image/jpeg" };
  }
  return {
    from: { id: userId, first_name: "Cust" },
    message,
    reply: async (t: string, opts?: any) => {
      replies.push({ text: t, opts });
      return {} as any;
    },
    _replies: replies,
  };
}

function callbacksOf(kb: any): string[] {
  return (kb?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data as string);
}

describe("product offer cards (AI identifies, customer confirms)", () => {
  test("a product request shows a confirmation card but does NOT add to cart", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu
      .createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000, description: "قهوه تلخ" })
      .id;
    app = buildApp({
      type: "product_offer",
      reply: "اسپرسو برایتان آماده می‌کنم.",
      actions: [],
      offers: [{ productId: espId, variantId: null, quantity: 1 }],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("یه اسپرسو می‌خوام");
    await bot._handlers.get("message:text")!(ctx);

    // Card shown with name, price, and add/cancel buttons
    expect(ctx._replies.length).toBe(1);
    const text = ctx._replies[0]!.text;
    expect(text).toContain("اسپرسو");
    expect(text).toContain("80,000");
    const cbs = callbacksOf(ctx._replies[0]!.opts?.reply_markup);
    expect(cbs.some((c) => c?.startsWith("aq:"))).toBe(true);
    expect(cbs).toContain("oc");
    // NOTHING added to the cart automatically
    expect(app.cart.getTotals(555).lines.length).toBe(0);
  });

  test("a price question shows price info but does NOT add to cart", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({
      type: "price_check",
      reply: "قیمت اسپرسو ۸۰٬۰۰۰ تومان است.",
      actions: [],
      offers: [{ productId: espId, variantId: null, quantity: 1 }],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("اسپرسو چند تومنه؟");
    await bot._handlers.get("message:text")!(ctx);

    expect(ctx._replies[0]!.text).toContain("اسپرسو");
    expect(app.cart.getTotals(555).lines.length).toBe(0);
  });

  test("an unavailable product card shows ناموجود with no add button", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    menu.updateProduct(espId, { active: false });
    app = buildApp({
      type: "product_offer",
      reply: "متأسفانه ناموجود است.",
      actions: [],
      offers: [{ productId: espId, variantId: null, quantity: 1 }],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    const ctx = fakeCtx("یه اسپرسو می‌خوام");
    await bot._handlers.get("message:text")!(ctx);

    const text = ctx._replies[0]!.text;
    expect(text).toContain("ناموجود");
    const cbs = callbacksOf(ctx._replies[0]!.opts?.reply_markup);
    expect(cbs.some((c) => c?.startsWith("aq:"))).toBe(false);
    expect(cbs).toContain("oc");
    // Even a forged add callback must be rejected by the backend.
    const forged = makeCallbackCtx(`aq:${espId}:0:1:deadbeef`);
    await bot._handlers.get("callback_query")!(forged);
    expect(app.cart.getTotals(555).lines.length).toBe(0);
  });

  test("the offer add button (aq) adds the requested quantity; double press is rejected", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);

    const token = app.tokens.mint(555, `aq:${espId}:0:2`);
    const data = `aq:${espId}:0:2:${token}`;
    await bot._handlers.get("callback_query")!(makeCallbackCtx(data));
    expect(app.cart.getTotals(555).lines[0]!.quantity).toBe(2);

    const second = makeCallbackCtx(data);
    await bot._handlers.get("callback_query")!(second);
    expect(app.cart.getTotals(555).lines[0]!.quantity).toBe(2);
    expect(second._answers.some((a) => a?.text?.includes("قبلاً"))).toBe(true);
  });

  test("the offer cancel button does not touch the cart", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const ctx = makeCallbackCtx("oc");
    await bot._handlers.get("callback_query")!(ctx);
    expect(app.cart.getTotals(555).lines.length).toBe(0);
    expect(ctx._edits.length).toBe(1);
    expect(ctx._edits[0]!.text).toContain("لغو");
  });

  test("several matched products are all presented (multi-offer)", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const a = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    const b = menu.createProduct({ categoryId: cat.id, name: "کاپوچینو", fixedPriceAmount: 120000 }).id;
    app = buildApp({
      type: "product_offer",
      reply: "کدام را می‌خواهید؟",
      actions: [],
      offers: [
        { productId: a, variantId: null, quantity: 1 },
        { productId: b, variantId: null, quantity: 1 },
      ],
      needsClarification: true,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("یه قهوه می‌خوام");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._replies.length).toBe(2);
    expect(ctx._replies[0]!.text).toContain("اسپرسو");
    expect(ctx._replies[1]!.text).toContain("کاپوچینو");
  });
});

describe("cart intents through the AI pipeline", () => {
  test("cart_view intent renders the real cart with server-computed totals", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "cart_view", reply: "سبد شما:", actions: [], needsClarification: false });
    app.cart.addItem(555, espId, null, 2);

    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سبد خریدم رو نشون بده");
    await bot._handlers.get("message:text")!(ctx);

    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("اسپرسو");
    expect(all).toContain("160,000"); // 2 × 80,000 computed on the server
  });

  test("set_qty action from the model updates the line quantity", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({
      type: "cart_action",
      reply: "تعداد کاپوچینو دو شد.",
      actions: [{ type: "set_qty", productId: espId, variantId: null, quantity: 2 }],
      needsClarification: false,
    });
    app.cart.addItem(555, espId, null, 1);

    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("تعداد اسپرسو رو دو تا کن");
    await bot._handlers.get("message:text")!(ctx);

    expect(app.cart.getTotals(555).lines[0]!.quantity).toBe(2);
  });

  test("remove action decreases quantity and empty line disappears", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({
      type: "cart_action",
      reply: "حذف شد.",
      actions: [{ type: "remove", productId: espId, variantId: null, quantity: 1 }],
      needsClarification: false,
    });
    app.cart.addItem(555, espId, null, 1);

    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    await bot._handlers.get("message:text")!(fakeCtx("اسپرسو رو حذف کن"));

    expect(app.cart.getTotals(555).lines.length).toBe(0);
  });

  test("clear via the model asks for confirmation and does not wipe the cart immediately", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({
      type: "cart_action",
      reply: "مطمئن هستید؟",
      actions: [{ type: "clear" }],
      needsClarification: false,
    });
    app.cart.addItem(555, espId, null, 1);

    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);
    const ctx = fakeCtx("سبدم رو خالی کن");
    await bot._handlers.get("message:text")!(ctx);

    // Confirmation shown, cart still intact
    expect(ctx._replies[0]!.text).toContain("مطمئن");
    expect(app.cart.getTotals(555).lines.length).toBe(1);

    // Confirming via the callback clears it
    const tok = app.tokens.mint(555, "clry");
    await bot._handlers.get("callback_query")!(makeCallbackCtx(`clry:${tok}`));
    expect(app.cart.getTotals(555).lines.length).toBe(0);
  });

  test("an add action for an unavailable product is rejected by the backend", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    menu.updateProduct(espId, { active: false });
    app = buildApp({
      type: "cart_action",
      reply: "اضافه شد.", // model claims success...
      actions: [{ type: "add", productId: espId, variantId: null, quantity: 1 }],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("اسپرسو اضافه کن");
    await bot._handlers.get("message:text")!(ctx);

    // ...but the backend refused: cart empty, and the error is surfaced.
    expect(app.cart.getTotals(555).lines.length).toBe(0);
    expect(ctx._replies[0]!.text).toContain("اضافه شد."); // model text
    expect(ctx._replies[0]!.text).toContain("موجود نیست"); // backend error appended
  });

  test("general small talk does not mutate the cart or state", async () => {
    app = buildApp({
      type: "chat",
      reply: "سلام! خوبم، ممنون.",
      actions: [],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سلام، خوبی؟");
    await bot._handlers.get("message:text")!(ctx);

    expect(ctx._replies[0]!.text).toContain("سلام!");
    expect(app.cart.getTotals(555).lines.length).toBe(0);
    expect(app.cart.get(555)?.state).toBe("browsing");
    // No keyboard spam on conversational replies
    expect(ctx._replies[0]!.opts?.reply_markup).toBeUndefined();
  });
});

describe("checkout, payment, and receipt via conversation", () => {
  /** Build an app with one espresso product and 2 units in the customer's cart. */
  function appWithSeededCart(aiResult: AiResult): { app: BotApp; espId: number } {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu
      .createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 })
      .id;
    const built = buildApp(aiResult);
    built.cart.addItem(555, espId, null, 2);
    return { app: built, espId };
  }

  test("checkout intent drives the real checkout flow with payment instructions", async () => {
    const built = appWithSeededCart({ type: "checkout", reply: "بریم سراغ تسویه.", actions: [], needsClarification: false });
    app = built.app;
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سفارشم رو ثبت کن");
    await bot._handlers.get("message:text")!(ctx);

    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("160,000");
    expect(all).toContain("603799"); // real card number from settings
    expect(all).toContain("رسید");
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");
  });

  test("empty cart checkout is rejected with an honest message", async () => {
    app = buildApp({ type: "checkout", reply: "ok", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سفارشم رو ثبت کن");
    await bot._handlers.get("message:text")!(ctx);
    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("خالی");
    expect(app.cart.get(555)?.state).toBe("browsing");
  });

  test("checkout is refused when no payment method is configured", async () => {
    app = appWithSeededCart({ type: "checkout", reply: "ok", actions: [], needsClarification: false }).app;
    updatePaymentSettings(db, { cardNumber: "", cardholderName: "", currency: "تومان" });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سفارشم رو ثبت کن");
    await bot._handlers.get("message:text")!(ctx);
    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("راه‌اندازی نشده");
    expect(app.cart.get(555)?.state).toBe("browsing");
  });

  test("text instead of a screenshot re-prompts for the receipt", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("پرداخت رو انجام دادم");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._replies[0]!.text).toContain("رسید");
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");
  });

  test("a payment screenshot attaches the receipt and advances to delivery stage", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = makeMediaCtx("photo");
    await bot._handlers.get("message:photo")!(ctx);

    expect(app.cart.get(555)?.state).toBe("checkout_delivery");
    expect(app.cart.get(555)?.receiptFileId).toBe("receipt-file");
    expect(ctx._replies.some((r) => r.text.includes("رسید دریافت شد"))).toBe(true);
  });

  test("duplicate screenshots after the receipt stage are not re-attached", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    app.orders.attachReceipt(555, "receipt-file", 42);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = makeMediaCtx("photo");
    await bot._handlers.get("message:photo")!(ctx);

    expect(app.cart.get(555)?.receiptFileId).toBe("receipt-file"); // unchanged
    expect(ctx._replies.some((r) => r.text.includes("قبلاً"))).toBe(true);
  });

  test("unsupported file types are rejected at the receipt stage", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = makeMediaCtx("document", 555, {});
    // Non-image document
    (ctx.message as any).document = { file_id: "virus", file_size: 100, mime_type: "application/zip" };
    await bot._handlers.get("message:document")!(ctx);
    expect(app.cart.get(555)?.receiptFileId).toBeNull();
  });

  test("full conversational order creates a durable order visible to the admin flow", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    // 1. Add via explicit action
    app.cart.addItem(555, espId, null, 2);
    // 2. Start checkout via callback
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");
    // 3. Send receipt screenshot
    await bot._handlers.get("message:photo")!(makeMediaCtx("photo"));
    expect(app.cart.get(555)?.state).toBe("checkout_delivery");
    // 4. Delivery notes via free text
    const notesCtx = fakeCtx("طبقه دوم");
    await bot._handlers.get("message:text")!(notesCtx);
    expect(app.cart.get(555)?.state).toBe("checkout_confirm");
    // 5. Final confirm with the one-shot token from the keyboard
    const confirmData = callbacksOf(notesCtx._replies[0]!.opts?.reply_markup).find((c) =>
      c?.startsWith("cf:"),
    )!;
    const confirmCtx = makeCallbackCtx(confirmData);
    await bot._handlers.get("callback_query")!(confirmCtx);

    // Order persisted with snapshot and receipt
    const latest = app.orders.latestOrderFor(555);
    expect(latest).not.toBeNull();
    expect(latest!.totalAmount).toBe(160000);
    expect(latest!.items[0]!.unitPrice).toBe(80000);
    expect(latest!.items[0]!.quantity).toBe(2);
    expect(latest!.receiptFileId).toBe("receipt-file");
    expect(latest!.status).toBe("receipt_received_unverified");
    // Confirmation mentions the order number
    expect(confirmCtx._replies.some((r) => r.text.includes(latest!.orderNumber))).toBe(true);
    // Cart finalized
    expect(app.cart.getTotals(555).lines.length).toBe(0);
    // Duplicate confirm is rejected (token already consumed)
    const dup = makeCallbackCtx(confirmData);
    await bot._handlers.get("callback_query")!(dup);
    expect(app.orders.listRecent(10).filter((o) => o.customerTelegramId === 555).length).toBe(1);
  });

  test("cancel during checkout clears pending checkout state honestly", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    app.cart.addItem(555, espId, null, 1);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");

    const ctx = makeCallbackCtx("cx");
    await bot._handlers.get("callback_query")!(ctx);
    expect(app.cart.get(555)?.state).toBe("browsing");
    expect(app.cart.get(555)?.receiptFileId).toBeNull();
    // Cart items are preserved for a retry
    expect(app.cart.getTotals(555).lines.length).toBe(1);
  });

  test("order_status intent answers deterministically from the database", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "order_status", reply: "جعلی!", actions: [], needsClarification: false });
    // Place an order behind the scenes
    app.cart.addItem(555, espId, null, 1);
    app.orders.startCheckout(555);
    app.orders.attachReceipt(555, "f", 1);
    app.orders.setDeliveryNotes(555, null);
    const conf = app.orders.confirmOrder(555, "Cust");
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;

    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سفارشم کجاست؟");
    await bot._handlers.get("message:text")!(ctx);

    // The reply must come from the DB (order number), not from the model text.
    expect(ctx._replies[0]!.text).toContain(conf.order.orderNumber);
  });

  test("carts are isolated between customers in the conversational path", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({
      type: "cart_action",
      reply: "اضافه شد.",
      actions: [{ type: "add", productId: espId, variantId: null, quantity: 1 }],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    await bot._handlers.get("message:text")!(fakeCtx("اسپرسو اضافه کن", { id: 555 }));
    await bot._handlers.get("message:text")!(fakeCtx("اسپرسو اضافه کن", { id: 666 }));

    expect(app.cart.getTotals(555).lines.length).toBe(1);
    expect(app.cart.getTotals(666).lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: free-text must never hit the hardcoded «AI disabled» reply when
// an Ollama endpoint is configured (root cause: index.ts gated on API key).
// ---------------------------------------------------------------------------

describe("bug fix: free-text reaches the AI pipeline", () => {
  test("a normal Persian greeting gets a model reply, never the disabled message", async () => {
    app = buildApp({
      type: "chat",
      reply: "سلام! خوبم، ممنون. چطور کمکتان کنم؟",
      actions: [],
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("سلام، خوبی؟");
    await bot._handlers.get("message:text")!(ctx);

    expect(ctx._replies.length).toBe(1);
    expect(ctx._replies[0]!.text).toContain("چطور کمکتان کنم");
    expect(ctx._replies[0]!.text).not.toBe(AI_DISABLED_REPLY);
    expect(aiInputs.length).toBe(1);
    expect(aiInputs[0]!.message).toBe("سلام، خوبی؟");
  });

  test("a price question reaches the AI with the real catalog data", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000, description: "تلخ" });
    app = buildApp({ type: "chat", reply: "در منو نگاه کنید", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    await bot._handlers.get("message:text")!(fakeCtx("اسپرسو سینگل چند تومنه؟"));

    expect(aiInputs.length).toBe(1);
    const catalogNames = aiInputs[0]!.catalog.products.map((p) => p.name);
    expect(catalogNames).toContain("اسپرسو");
  });

  test("the intentional disabled service still returns the disabled message", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    // Simulate a config with no Ollama endpoint (the only legit "disabled" case).
    app.ai = createDisabledAiService();
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("سلام، خوبی؟");
    await bot._handlers.get("message:text")!(ctx);

    expect(ctx._replies[0]!.text).toBe(AI_DISABLED_REPLY);
  });

  test("empty API key against a configured endpoint shows 'unavailable', not 'disabled'", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    // Real OllamaService with the real wiring: empty key, endpoint configured.
    app.ai = createAiService({ apiKey: "", baseUrl: "https://ollama.com/v1", model: "gemma4:cloud" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
      })) as unknown as typeof fetch;
    try {
      const bot = fakeBot();
      registerMessageHandlers(bot, app);
      const ctx = fakeCtx("من یه اسپرسو سینگل می‌خوام");
      await bot._handlers.get("message:text")!(ctx);

      expect(ctx._replies[0]!.text).toBe(AI_UNAVAILABLE_REPLY);
      expect(ctx._replies[0]!.text).not.toBe(AI_DISABLED_REPLY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a payment screenshot never enters the text-only AI handler", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    app.cart.addItem(555, espId, null, 1);
    app.orders.startCheckout(555);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    await bot._handlers.get("message:photo")!(makeMediaCtx("photo"));

    expect(aiInputs.length).toBe(0); // AI was never consulted
    expect(app.cart.get(555)?.state).toBe("checkout_delivery");
  });

  test("a failing Telegram reply is not counted as delivered (no assistant history)", async () => {
    app = buildApp({ type: "chat", reply: "پاسخ مدل", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("سلام");
    ctx.reply = async () => {
      throw new Error("telegram network error");
    };
    // The handler must not throw out of the pipeline (grammY-level errors are
    // caught), and no assistant turn may be recorded as "delivered".
    await bot._handlers.get("message:text")!(ctx);

    const history = app.history.get(555) ?? [];
    expect(history.some((h) => h.role === "assistant")).toBe(false);
    expect(history.some((h) => h.role === "user")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Profiles, wallet, order history, unsupported types (through real handlers)
// ---------------------------------------------------------------------------

describe("customer flows through the bot", () => {
  function flowCtx(text: string, userId = 555) {
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

  function mediaCtxNoReceipt(userId = 555) {
    const replies: { text: string; opts?: any }[] = [];
    return {
      from: { id: userId },
      message: { message_id: 9, voice: { file_id: "v", duration: 2 } },
      reply: async (t: string, opts?: any) => {
        replies.push({ text: t, opts });
        return {} as any;
      },
      _replies: replies,
    };
  }

  function cbCtx(data: string, userId = 555) {
    const replies: { text: string; opts?: any }[] = [];
    const answers: any[] = [];
    return {
      from: { id: userId, first_name: "Cust" },
      callbackQuery: { data },
      answerCallbackQuery: async (o?: any) => {
        answers.push(o);
        return {} as any;
      },
      reply: async (t: string, opts?: any) => {
        replies.push({ text: t, opts });
        return {} as any;
      },
      editMessageText: async (t: string) => {
        replies.push({ text: t });
        return {} as any;
      },
      _replies: replies,
      _answers: answers,
    };
  }

  test("profile edit flow: menu → edit → save → shown back", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("prof"));
    await bot._handlers.get("callback_query")!(cbCtx("profedit"));
    // Next text is captured by the profile flow, not the AI.
    const edit = flowCtx("علی | رضایی | ۰۹۱۲۱۲۳۴۵۶۷");
    await bot._handlers.get("message:text")!(edit);

    const p = app.customers.getProfile(555);
    expect(p?.firstName).toBe("علی");
    expect(p?.phone).toBe("09121234567");
    expect(edit._replies.some((r) => r.text.includes("پروفایل ذخیره شد"))).toBe(true);
    expect(aiInputs.length).toBe(0); // captured, never reached the AI
  });

  test("deposit flow: menu → amount → pending request with payment info", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("wdep"));
    const amountMsg = flowCtx("۱۰۰۰۰۰");
    await bot._handlers.get("message:text")!(amountMsg);

    const deposits = app.customers.listDeposits(555);
    expect(deposits.length).toBe(1);
    expect(deposits[0]!.status).toBe("pending");
    expect(deposits[0]!.amount).toBe(100000);
    expect(amountMsg._replies.some((r) => r.text.includes("603799"))).toBe(true);
    expect(aiInputs.length).toBe(0);
  });

  test("order history is scoped and paginated", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    for (let i = 0; i < 7; i++) {
      app.cart.addItem(555, waterId, null, 1);
      app.orders.startCheckout(555);
      app.orders.attachReceipt(555, `f${i}`, i);
      app.orders.setDeliveryNotes(555, null);
      const conf = app.orders.confirmOrder(555, "C");
      expect(conf.ok).toBe(true);
    }
    const ctx = cbCtx("oh");
    await bot._handlers.get("callback_query")!(ctx);
    // First page shows 5 of 7 with an older-page button.
    expect(ctx._replies[0]!.text.split("\n").filter((l) => l.startsWith("•")).length).toBe(5);
    expect(ctx._replies[0]!.opts?.reply_markup).toBeDefined();

    // Another customer sees nothing.
    const other = cbCtx("oh", 666);
    await bot._handlers.get("callback_query")!(other);
    expect(other._replies[0]!.text).toContain("ثبت نشده");
  });

  test("unsupported message types get the polite fallback, not the AI", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = mediaCtxNoReceipt();
    await bot._handlers.get("message")!(ctx);
    expect(ctx._replies[0]!.text).toContain("فقط پیام متنی");
    expect(aiInputs.length).toBe(0);
  });

  test("the usual: repeated orders produce a suggestion from real history", () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    for (let i = 0; i < 3; i++) {
      app.cart.addItem(555, waterId, null, 2);
      app.orders.startCheckout(555);
      app.orders.attachReceipt(555, `f${i}`, i);
      app.orders.setDeliveryNotes(555, null);
      app.orders.confirmOrder(555, "C");
    }
    const usual = app.loyalty.usualFor(555);
    expect(usual.primary.length).toBe(1);
    expect(usual.primary[0]!.productName).toBe("آب");
    expect(usual.primary[0]!.avgQuantity).toBe(2);
    // A customer with no history gets nothing invented.
    expect(app.loyalty.usualFor(999).primary.length).toBe(0);
  });
});
