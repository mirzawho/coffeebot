import { describe, test, expect, beforeEach, setSystemTime } from "bun:test";
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
import { NotificationService } from "../src/services/notifications";
import { ChannelMembershipService } from "../src/services/membership";
import { ReferralService } from "../src/services/referrals";
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
    notifications: new NotificationService(db),
    membership: new ChannelMembershipService(db),
    referrals: new ReferralService(db),
    profileEdit: new TextCaptureFlow(),
    depositFlow: new TextCaptureFlow(),
    rejectReasonFlow: new TextCaptureFlow(),
    referralFlow: new TextCaptureFlow(),
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
  const edits: { text: string; opts?: any; kind?: string }[] = [];
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
      edits.push({ text: t, opts, kind: "text" });
      return {} as any;
    },
    editMessageCaption: async (other: any) => {
      edits.push({ text: other?.caption ?? "", opts: other, kind: "caption" });
      return {} as any;
    },
    editMessageReplyMarkup: async () => {
      edits.push({ text: "", opts: { reply_markup: null }, kind: "markup" });
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
    // The customer picks a payment method before any card details are shown.
    expect(all).toContain("روش پرداخت");
    expect(all).toContain("موجودی کیف پول");
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
    const buttons = callbacksOf(ctx._replies[ctx._replies.length - 1]!.opts?.reply_markup);
    expect(buttons).toContain("pm:c");
    // Wallet is not offered with an empty balance.
    expect(buttons).not.toContain("pm:w");
  });

  test("choosing card-to-card shows the card details and asks for the receipt", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    const ctx = makeCallbackCtx("pm:c");
    await bot._handlers.get("callback_query")!(ctx);

    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("603799");
    expect(all).toContain("رسید");
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");
    expect(app.cart.get(555)?.paymentMethod).toBe("card_to_card");
  });

  test("choosing wallet shows the balance and skips the receipt stage", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const dep = app.customers.createDeposit(555, 200000);
    if (!dep.ok) throw new Error("deposit failed");
    app.customers.approveDeposit(dep.deposit.id, 777);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    const ctx = makeCallbackCtx("pm:w");
    await bot._handlers.get("callback_query")!(ctx);

    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("200,000"); // current balance
    expect(all).toContain("40,000"); // balance after paying 160,000
    // Wallet continues to the fulfillment question before final confirm.
    expect(app.cart.get(555)?.state).toBe("checkout_fulfillment");
    expect(app.cart.get(555)?.paymentMethod).toBe("wallet");
  });

  test("after payment the fulfillment buttons place the order; typing edits it", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const dep = app.customers.createDeposit(555, 200000);
    if (!dep.ok) throw new Error("deposit failed");
    app.customers.approveDeposit(dep.deposit.id, 777);
    // The customer has an address → both options are offered.
    app.customers.saveProfile(555, { fullName: "علی", address: "تهران، ولیعصر" });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    await bot._handlers.get("callback_query")!(makeCallbackCtx("pm:w"));

    // Wallet waits on the fulfillment keyboard — no order yet.
    expect(app.cart.get(555)?.state).toBe("checkout_fulfillment");
    const pick = makeCallbackCtx("fm:d");
    await bot._handlers.get("callback_query")!(pick);
    // The press places the order immediately (wallet charged) and edits the message.
    expect(app.cart.get(555)?.state).toBe("browsing");
    const order = app.orders.latestOrderFor(555);
    expect(order).not.toBeNull();
    expect(order!.fulfillmentMethod).toBe("delivery");
    expect(order!.paymentStatus).toBe("paid");
    const shown = pick._edits.map((e) => e.text).join("\n");
    expect(shown).toContain("ارسال 🛵");

    // Typed text related to the order edits it; unrelated text goes to the AI.
    const timeCtx = fakeCtx("ساعت ۵ عصر");
    await bot._handlers.get("message:text")!(timeCtx);
    expect(app.orders.latestOrderFor(555)!.deliveryTime).toBe("ساعت ۵ عصر");
    expect(timeCtx._replies.map((r) => r.text).join("\n")).toContain("ساعت ۵ عصر");
  });

  test("the placed-order keyboard carries delivery + quick-time buttons", async () => {
    // The quick-time buttons are only offered while the café is open — pin an
    // open Monday hour so the expectation is deterministic.
    setSystemTime(new Date("2026-10-12T10:00:00+03:30"));
    try {
      app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
      app.orders.startCheckout(555);
      app.orders.choosePaymentMethod(555, "card_to_card");
      const bot = fakeBot();
      registerMessageHandlers(bot, app);
      registerCallbackHandlers(bot, app);
      const media = makeMediaCtx("photo");
      await bot._handlers.get("message:photo")!(media);

      // The receipt placed the order and the summary offers the new keyboard.
      const summary = media._replies.find((r) => r.opts?.reply_markup)!;
      expect(callbacksOf(summary.opts.reply_markup)).toEqual([
        "fm:p",
        "ft:now",
        "ft:tomorrow",
        "ft:5m",
        "ft:10m",
      ]);

      // «۵ دقیقه بعد» resolves to a concrete clock time and refreshes the message.
      const press = makeCallbackCtx("ft:5m");
      await bot._handlers.get("callback_query")!(press);
      const order = app.orders.latestOrderFor(555)!;
      expect(order.deliveryTime).toMatch(/^ساعت [۰-۹]{1,2}:[۰-۹]{2}$/);
      expect(press._edits.map((e) => e.text).join("\n")).toContain("تحویل حضوری 🏪");

      // A press with nothing to place and nothing placed is refused.
      const stale = makeCallbackCtx("ft:now", 999);
      await bot._handlers.get("callback_query")!(stale);
      expect(stale._answers.some((a) => a?.show_alert)).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test("delivery without a saved address is refused; pickup always works", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const dep = app.customers.createDeposit(555, 200000);
    if (!dep.ok) throw new Error("deposit failed");
    app.customers.approveDeposit(dep.deposit.id, 777);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    await bot._handlers.get("callback_query")!(makeCallbackCtx("pm:w"));

    // No address → the delivery press is refused with an alert.
    const pick = makeCallbackCtx("fm:d");
    await bot._handlers.get("callback_query")!(pick);
    expect(pick._answers.some((a) => (a.text ?? "").includes("آدرس"))).toBe(true);
    expect(app.cart.get(555)?.state).toBe("checkout_fulfillment");
    expect(app.orders.latestOrderFor(555)).toBeNull();

    // Pickup works and places the order.
    await bot._handlers.get("callback_query")!(makeCallbackCtx("fm:p"));
    expect(app.cart.get(555)?.state).toBe("browsing");
    const order = app.orders.latestOrderFor(555);
    expect(order).not.toBeNull();
    expect(order!.fulfillmentMethod).toBe("pickup");
  });

  test("wallet choice with an insufficient balance is refused with an alert", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    const ctx = makeCallbackCtx("pm:w");
    await bot._handlers.get("callback_query")!(ctx);

    expect(ctx._answers.some((a) => (a.text ?? "").includes("کافی نیست"))).toBe(true);
    // Still on the picker — the customer can pay by card instead.
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
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

  test("checkout is refused when no payment method is usable", async () => {
    app = appWithSeededCart({ type: "checkout", reply: "ok", actions: [], needsClarification: false }).app;
    // Card-to-card switched off, and the wallet is empty — nothing can pay.
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("سفارشم رو ثبت کن");
    await bot._handlers.get("message:text")!(ctx);
    const all = ctx._replies.map((r) => r.text).join("\n");
    expect(all).toContain("راه‌اندازی نشده");
    expect(app.cart.get(555)?.state).toBe("browsing");
  });

  test("card-to-card switched off hides the button and refuses the choice", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const dep = app.customers.createDeposit(555, 500000);
    if (!dep.ok) throw new Error("deposit failed");
    app.customers.approveDeposit(dep.deposit.id, 777);
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
    });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const co = makeCallbackCtx("co");
    await bot._handlers.get("callback_query")!(co);
    const buttons = callbacksOf(co._replies[co._replies.length - 1]!.opts?.reply_markup);
    expect(buttons).toContain("pm:w");
    expect(buttons).not.toContain("pm:c");

    // A stale card button must be refused server-side.
    const stale = makeCallbackCtx("pm:c");
    await bot._handlers.get("callback_query")!(stale);
    expect(stale._answers.some((a) => (a.text ?? "").includes("غیرفعال"))).toBe(true);
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
  });

  test("wallet switched off hides the button even with a sufficient balance", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    const dep = app.customers.createDeposit(555, 500000);
    if (!dep.ok) throw new Error("deposit failed");
    app.customers.approveDeposit(dep.deposit.id, 777);
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      walletEnabled: false,
    });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const co = makeCallbackCtx("co");
    await bot._handlers.get("callback_query")!(co);
    const buttons = callbacksOf(co._replies[co._replies.length - 1]!.opts?.reply_markup);
    expect(buttons).toContain("pm:c");
    expect(buttons).not.toContain("pm:w");

    const stale = makeCallbackCtx("pm:w");
    await bot._handlers.get("callback_query")!(stale);
    expect(stale._answers.some((a) => (a.text ?? "").includes("غیرفعال"))).toBe(true);
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
  });

  test("wallet top-up is refused while card-to-card is switched off", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
    });
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const ctx = makeCallbackCtx("wdep");
    await bot._handlers.get("callback_query")!(ctx);
    expect(ctx._replies.some((r) => r.text.includes("غیرفعال"))).toBe(true);
    // The amount-capture flow was never armed.
    expect(app.depositFlow.isActive(555)).toBe(false);
  });

  test("text on the payment screen re-prompts for a payment method", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("چطور پرداخت کنم؟");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._replies[0]!.text).toContain("روش‌های پرداخت");
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
    expect(aiInputs.length).toBe(0); // deterministic, never the AI
  });

  test("text instead of a screenshot re-prompts for the receipt", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    app.orders.choosePaymentMethod(555, "card_to_card");
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("پرداخت رو انجام دادم");
    await bot._handlers.get("message:text")!(ctx);
    expect(ctx._replies[0]!.text).toContain("رسید");
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");
  });

  test("a payment screenshot places the order right away with a thanks + summary", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    app.orders.choosePaymentMethod(555, "card_to_card");
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = makeMediaCtx("photo");
    await bot._handlers.get("message:photo")!(ctx);

    // No extra confirm step: the receipt itself creates the order.
    expect(app.cart.get(555)?.state).toBe("browsing");
    const order = app.orders.latestOrderFor(555);
    expect(order).not.toBeNull();
    expect(order!.receiptFileId).toBe("receipt-file");
    expect(order!.fulfillmentMethod).toBe("pickup"); // default
    const reply = ctx._replies.map((r) => r.text).join("\n");
    expect(reply).toContain("رسید شما دریافت شد");
    expect(reply).toContain(order!.orderNumber);
    expect(reply).toContain("در انتظار تأیید مدیر");
  });

  test("a screenshot sent straight from the payment screen is accepted", async () => {
    app = appWithSeededCart({ type: "chat", reply: "x", actions: [], needsClarification: false }).app;
    app.orders.startCheckout(555);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = makeMediaCtx("photo");
    await bot._handlers.get("message:photo")!(ctx);

    const order = app.orders.latestOrderFor(555);
    expect(order).not.toBeNull();
    expect(order!.paymentMethod).toBe("card_to_card");
    expect(app.cart.get(555)?.state).toBe("browsing");
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
    expect(app.orders.latestOrderFor(555)).toBeNull(); // nothing was placed twice
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
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
    // 3. Choose card-to-card
    await bot._handlers.get("callback_query")!(makeCallbackCtx("pm:c"));
    expect(app.cart.get(555)?.state).toBe("checkout_receipt");
    // 4. Send receipt screenshot — the order is placed immediately
    const media = makeMediaCtx("photo");
    await bot._handlers.get("message:photo")!(media);
    expect(app.cart.get(555)?.state).toBe("browsing");

    // Order persisted with snapshot and receipt
    const latest = app.orders.latestOrderFor(555);
    expect(latest).not.toBeNull();
    expect(latest!.totalAmount).toBe(160000);
    expect(latest!.items[0]!.unitPrice).toBe(80000);
    expect(latest!.items[0]!.quantity).toBe(2);
    expect(latest!.receiptFileId).toBe("receipt-file");
    expect(latest!.status).toBe("receipt_received_unverified");
    expect(latest!.paymentMethod).toBe("card_to_card");
    expect(latest!.paymentStatus).toBe("receipt_received");
    // The receipt message thanks the customer and shows the order number.
    expect(media._replies.some((r) => r.text.includes(latest!.orderNumber))).toBe(true);
    // Cart finalized
    expect(app.cart.getTotals(555).lines.length).toBe(0);

    // 5. The buttons on the placed message edit delivery without any confirm step.
    const tomorrow = makeCallbackCtx("ft:tomorrow");
    await bot._handlers.get("callback_query")!(tomorrow);
    expect(app.orders.latestOrderFor(555)!.deliveryTime).toBe("فردا");
    // Delivery without an address is refused; typing «فردا» also edits.
    const delivery = makeCallbackCtx("fm:d");
    await bot._handlers.get("callback_query")!(delivery);
    expect(delivery._answers.some((a) => (a.text ?? "").includes("آدرس"))).toBe(true);
    expect(app.orders.latestOrderFor(555)!.fulfillmentMethod).toBe("pickup");
    // Re-renders still show exactly one order.
    expect(app.orders.listRecent(10).filter((o) => o.customerTelegramId === 555).length).toBe(1);
  });

  test("full wallet order charges the wallet and reports the remaining balance", async () => {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const dep = app.customers.createDeposit(555, 200000);
    if (!dep.ok) throw new Error("deposit failed");
    app.customers.approveDeposit(dep.deposit.id, 777);
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    app.cart.addItem(555, espId, null, 2);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    const walletCtx = makeCallbackCtx("pm:w");
    await bot._handlers.get("callback_query")!(walletCtx);
    expect(app.cart.get(555)?.state).toBe("checkout_fulfillment");

    // The first fulfillment press charges the wallet and places the order.
    const pick = makeCallbackCtx("fm:p");
    await bot._handlers.get("callback_query")!(pick);

    const order = app.orders.latestOrderFor(555);
    expect(order).not.toBeNull();
    expect(order!.paymentMethod).toBe("wallet");
    expect(order!.paymentStatus).toBe("paid");
    expect(order!.receiptFileId).toBeNull();
    expect(app.customers.getBalance(555)).toBe(40000);
    // The confirmation reports the remaining balance.
    const shown = [...pick._replies, ...pick._edits].map((r) => r.text).join("\n");
    expect(shown).toContain("40,000");
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
    expect(app.cart.get(555)?.state).toBe("checkout_payment");

    const ctx = makeCallbackCtx("cx");
    await bot._handlers.get("callback_query")!(ctx);
    expect(app.cart.get(555)?.state).toBe("browsing");
    expect(app.cart.get(555)?.receiptFileId).toBeNull();
    expect(app.cart.get(555)?.paymentMethod).toBeNull();
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
    app.cart.setFulfillmentMethod(555, "pickup");
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
    // The receipt itself placed the order — no extra confirm step.
    expect(app.cart.get(555)?.state).toBe("browsing");
    expect(app.orders.latestOrderFor(555)).not.toBeNull();
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

  test("profile wizard: menu → edit → name → phone → address → save", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("prof"));
    await bot._handlers.get("callback_query")!(cbCtx("profedit"));
    // Step 1: name — captured by the wizard, never the AI.
    const name = flowCtx("علی رضایی");
    await bot._handlers.get("message:text")!(name);
    expect(name._replies.some((r) => r.text.includes("۲ از ۳"))).toBe(true);
    // Step 2: phone — Persian digits are converted to English.
    const phone = flowCtx("۰۹۱۲۱۲۳۴۵۶۷");
    await bot._handlers.get("message:text")!(phone);
    expect(phone._replies.some((r) => r.text.includes("۳ از ۳"))).toBe(true);
    // Step 3: optional address.
    const addr = flowCtx("تهران، خیابان ولیعصر");
    await bot._handlers.get("message:text")!(addr);

    const p = app.customers.getProfile(555);
    expect(p?.fullName).toBe("علی رضایی");
    expect(p?.phone).toBe("09121234567");
    expect(p?.address).toBe("تهران، خیابان ولیعصر");
    expect(addr._replies.some((r) => r.text.includes("پروفایل ذخیره شد"))).toBe(true);
    expect(aiInputs.length).toBe(0); // captured, never reached the AI
  });

  test("profile wizard: invalid phone re-asks, address step can be skipped", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("profedit"));
    await bot._handlers.get("message:text")!(flowCtx("محمد محمدی"));
    // Bad phone stays on the phone step.
    const bad = flowCtx("12345");
    await bot._handlers.get("message:text")!(bad);
    expect(bad._replies.some((r) => r.text.includes("معتبر نیست"))).toBe(true);
    await bot._handlers.get("message:text")!(flowCtx("۰۹۱۲۳۴۵۶۷۸۹"));
    // «رد» skips the address.
    const skip = flowCtx("رد");
    await bot._handlers.get("message:text")!(skip);

    const p = app.customers.getProfile(555);
    expect(p?.fullName).toBe("محمد محمدی");
    expect(p?.phone).toBe("09123456789");
    expect(p?.address).toBeNull();
  });

  test("profile wizard: every step carries لغو / بعدی / تأیید buttons", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    const start = cbCtx("profedit");
    await bot._handlers.get("callback_query")!(start);
    // Step 1 (no saved name): only لغو is offered — name is required.
    let cbs = callbacksOf(start._replies[0]!.opts?.reply_markup);
    expect(cbs).toContain("pf:cancel");
    expect(cbs).not.toContain("pf:skip");

    const name = flowCtx("علی رضایی");
    await bot._handlers.get("message:text")!(name);
    // Step 2 (no saved phone): still no skip.
    cbs = callbacksOf(name._replies[0]!.opts?.reply_markup);
    expect(cbs).toContain("pf:cancel");
    expect(cbs).not.toContain("pf:skip");

    const phone = flowCtx("۰۹۱۲۱۲۳۴۵۶۷");
    await bot._handlers.get("message:text")!(phone);
    // Step 3 (address is optional): skip + confirm are offered.
    cbs = callbacksOf(phone._replies[0]!.opts?.reply_markup);
    expect(cbs).toContain("pf:skip");
    expect(cbs).toContain("pf:ok");
    expect(cbs).toContain("pf:cancel");
  });

  test("profile wizard: the لغو button aborts without saving", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("profedit"));
    await bot._handlers.get("message:text")!(flowCtx("علی رضایی"));
    const cancel = cbCtx("pf:cancel");
    await bot._handlers.get("callback_query")!(cancel);

    expect(cancel._replies.some((r) => r.text.includes("لغو شد"))).toBe(true);
    expect(app.customers.getProfile(555)).toBeNull();
    expect(app.profileEdit.isActive(555)).toBe(false);
    // A later text is no longer captured by the wizard.
    await bot._handlers.get("message:text")!(fakeCtx("سلام"));
    expect(aiInputs.length).toBe(1);
  });

  test("profile wizard: the تأیید button saves the collected fields", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("profedit"));
    await bot._handlers.get("message:text")!(flowCtx("علی رضایی"));
    await bot._handlers.get("message:text")!(flowCtx("۰۹۱۲۱۲۳۴۵۶۷"));
    const ok = cbCtx("pf:ok");
    await bot._handlers.get("callback_query")!(ok);

    const p = app.customers.getProfile(555);
    expect(p?.fullName).toBe("علی رضایی");
    expect(p?.phone).toBe("09121234567");
    expect(ok._replies.some((r) => r.text.includes("پروفایل ذخیره شد"))).toBe(true);
  });

  test("profile wizard: the بعدی button keeps the saved value and advances", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    app.customers.saveProfile(555, { fullName: "علی رضایی", phone: "09121234567" });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    const start = cbCtx("profedit");
    await bot._handlers.get("callback_query")!(start);
    // A saved name exists → skip is offered on step 1.
    expect(callbacksOf(start._replies[0]!.opts?.reply_markup)).toContain("pf:skip");
    await bot._handlers.get("callback_query")!(cbCtx("pf:skip"));
    // A saved phone exists → skip is offered on step 2.
    await bot._handlers.get("callback_query")!(cbCtx("pf:skip"));
    // Step 3: skip the address, then confirm.
    await bot._handlers.get("callback_query")!(cbCtx("pf:skip"));

    const p = app.customers.getProfile(555);
    expect(p?.fullName).toBe("علی رضایی");
    expect(p?.phone).toBe("09121234567");
    expect(p?.address).toBeNull();
  });

  test("/cancel aborts an active profile wizard and says so", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    registerCallbackHandlers(bot, app);

    await bot._handlers.get("callback_query")!(cbCtx("profedit"));
    const cancel = flowCtx("/cancel");
    await bot._handlers.get("message:text")!(cancel);

    expect(cancel._replies.some((r) => r.text.includes("لغو شد"))).toBe(true);
    expect(app.profileEdit.isActive(555)).toBe(false);
    expect(app.customers.getProfile(555)).toBeNull();
  });

  test("AI profile update: «من محمد محمدی هستم» saves the full name", async () => {
    app = buildApp({
      type: "profile_update",
      reply: "ثبت شد!",
      actions: [],
      profileFields: { fullName: "محمد محمدی" },
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("من محمد محمدی هستم");
    await bot._handlers.get("message:text")!(ctx);

    const p = app.customers.getProfile(555);
    expect(p?.fullName).toBe("محمد محمدی");
    expect(ctx._replies.some((r) => r.text.includes("پروفایل به‌روز شد"))).toBe(true);
  });

  test("AI profile update: Persian phone digits are normalized before saving", async () => {
    app = buildApp({
      type: "profile_update",
      reply: "شماره شما ثبت شد.",
      actions: [],
      profileFields: { phone: "۰۹۰۱۲۳۴۵۶۷۸۹" },
      needsClarification: false,
    });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    const ctx = fakeCtx("شماره موبایل من ۰۹۰۱۲۳۴۵۶۷۸۹ هست");
    await bot._handlers.get("message:text")!(ctx);

    // ۰۹۰۱۲۳۴۵۶۷۸۹ is 12 digits — invalid, so nothing is saved and the
    // backend error is surfaced honestly.
    expect(ctx._replies.some((r) => r.text.includes("معتبر نیست"))).toBe(true);
    expect(app.customers.getProfile(555)).toBeNull();
  });

  test("AI profile update: a valid phone saves and keeps the existing name", async () => {
    app = buildApp({
      type: "profile_update",
      reply: "شماره شما ثبت شد.",
      actions: [],
      profileFields: { phone: "09123456789" },
      needsClarification: false,
    });
    app.customers.saveProfile(555, { fullName: "محمد محمدی" });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);

    await bot._handlers.get("message:text")!(fakeCtx("شماره موبایلم 09123456789 است"));

    const p = app.customers.getProfile(555);
    expect(p?.fullName).toBe("محمد محمدی");
    expect(p?.phone).toBe("09123456789");
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
    // Copy buttons for amount + card number are attached to the payment request.
    const lastReply = amountMsg._replies[amountMsg._replies.length - 1]!;
    const copyBtns = (lastReply.opts?.reply_markup?.inline_keyboard ?? []).flat().filter((b: any) => b.copy_text);
    expect(copyBtns.length).toBe(2);
    expect(copyBtns.some((b: any) => b.copy_text.text === "100000")).toBe(true);
    expect(copyBtns.some((b: any) => b.copy_text.text === "603799")).toBe(true);
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
      app.cart.setFulfillmentMethod(555, "pickup");
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
      app.cart.setFulfillmentMethod(555, "pickup");
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

describe("cart-first checkout UX", () => {
  function seedCart(quantity = 2) {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    app.cart.addItem(555, waterId, null, quantity);
  }

  function buttonsFlat(kb: any): any[] {
    return (kb?.inline_keyboard ?? []).flat();
  }

  test("main menu has no checkout button and hides the cart button when the cart is empty", async () => {
    app = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    const bot = fakeBot();
    registerMessageHandlers(bot, app);
    const ctx = fakeCtx("/start");
    await bot._commands.get("start")!(ctx);
    const cbs = callbacksOf(ctx._replies[0]!.opts?.reply_markup);
    expect(cbs).not.toContain("co");
    expect(cbs).not.toContain("cart");

    // With items in the cart the cart button appears (still no checkout button).
    app.cart.addItem(555, waterId, null, 1);
    const ctx2 = fakeCtx("/start");
    await bot._commands.get("start")!(ctx2);
    const cbs2 = callbacksOf(ctx2._replies[0]!.opts?.reply_markup);
    expect(cbs2).toContain("cart");
    expect(cbs2).not.toContain("co");
  });

  test("checkout start sends ONE message combining the summary and the payment choice", async () => {
    seedCart(2);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const co = makeCallbackCtx("co");
    await bot._handlers.get("callback_query")!(co);

    expect(co._replies.length).toBe(1);
    const reply = co._replies[0]!;
    expect(reply.text).toContain("خلاصه سفارش");
    expect(reply.text).toContain("روش پرداخت");
    expect(reply.text).toContain("30,000"); // 2 × 15,000
    expect(reply.opts?.parse_mode).toBe("HTML");
    const buttons = callbacksOf(reply.opts?.reply_markup);
    expect(buttons).toContain("pm:c");
    expect(buttons).not.toContain("pm:w"); // empty wallet
    expect(app.cart.get(555)?.state).toBe("checkout_payment");
  });

  test("the cart keyboard shows a 4-button row per item and «پرداخت و ثبت سفارش»", async () => {
    seedCart(3);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const ctx = makeCallbackCtx("cart");
    await bot._handlers.get("callback_query")!(ctx);

    const kb = ctx._edits[0]?.opts?.reply_markup ?? ctx._replies[0]?.opts?.reply_markup;
    const rows = kb?.inline_keyboard ?? [];
    // First row: quantity label | − | + | delete
    expect(rows[0]!.length).toBe(4);
    expect(rows[0]![0]!.text).toContain("۳×"); // Persian digit + multiplier first
    expect(rows[0]![0]!.callback_data).toBe("cart");
    expect(callbacksOf(kb).some((c) => c?.startsWith("q:"))).toBe(true);
    expect(callbacksOf(kb).some((c) => c?.startsWith("r:"))).toBe(true);
    // The pay button carries the new label, not «تسویه حساب».
    const labels = buttonsFlat(kb).map((b) => b.text as string);
    expect(labels.some((t: string) => t.includes("پرداخت و ثبت سفارش"))).toBe(true);
    expect(labels.some((t: string) => t.includes("تسویه حساب"))).toBe(false);
  });

  test("card-to-card stage is one message with copy buttons for amount and card number", async () => {
    seedCart(2);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    const ctx = makeCallbackCtx("pm:c");
    await bot._handlers.get("callback_query")!(ctx);

    expect(ctx._replies.length).toBe(1);
    const reply = ctx._replies[0]!;
    expect(reply.text).toContain("603799");
    expect(reply.text).toContain("رسید");
    const copyBtns = buttonsFlat(reply.opts?.reply_markup).filter((b) => b.copy_text);
    expect(copyBtns.length).toBe(2);
    const labels = copyBtns.map((b) => b.text as string).join(" ");
    expect(labels).toContain("کپی مبلغ");
    expect(labels).toContain("شماره کارت");
    expect(copyBtns.some((b) => b.copy_text.text === "30000")).toBe(true);
    expect(copyBtns.some((b) => b.copy_text.text === "603799")).toBe(true);
  });

  test("card-to-card copy amount uses the after-hours price when the café is closed", async () => {
    // Product with a distinct after-hours price (checkout.test.ts pattern).
    new MenuService(db).updateProduct(waterId, { afterHoursPriceAmount: 20000 });
    seedCart(2);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);

    // Friday: closed by default schedule → after-hours price applies (2 × 20,000).
    setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const co = makeCallbackCtx("co");
      await bot._handlers.get("callback_query")!(co);
      expect(co._replies[0]!.text).toContain("40,000"); // startCheckout snapshot

      const ctx = makeCallbackCtx("pm:c");
      await bot._handlers.get("callback_query")!(ctx);
      expect(ctx._replies.length).toBe(1);
      expect(ctx._replies[0]!.text).toContain("40,000");
      const copyBtns = (ctx._replies[0]!.opts?.reply_markup?.inline_keyboard ?? [])
        .flat()
        .filter((b: any) => b.copy_text);
      expect(copyBtns.some((b: any) => b.copy_text.text === "40000")).toBe(true);
      expect(copyBtns.some((b: any) => b.copy_text.text === "20000")).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test("order history empty reply still shows the cart button when the cart has items", async () => {
    seedCart(1);
    const bot = fakeBot();
    registerCallbackHandlers(bot, app);
    const ctx = makeCallbackCtx("oh");
    await bot._handlers.get("callback_query")!(ctx);
    const cbs = callbacksOf(ctx._replies[0]!.opts?.reply_markup);
    expect(cbs).toContain("cart");
    expect(cbs).not.toContain("co");
  });
});

// ---------------------------------------------------------------------------
// Admin receipt review: تأیید/لغو buttons + reject-reason capture
// ---------------------------------------------------------------------------

describe("admin receipt review (confirm/reject keyboard)", () => {
  const ADMIN = 777;

  /** Card order placed exactly like the bot does (receipt → immediate order). */
  async function placeCardOrder(): Promise<{ app: BotApp; orderId: number; orderNumber: string }> {
    const menu = new MenuService(db);
    const cat = menu.listCategories(false)[0]!;
    const espId = menu
      .createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 })
      .id;
    const built = buildApp({ type: "chat", reply: "x", actions: [], needsClarification: false });
    built.cart.addItem(555, espId, null, 1);
    const bot = fakeBot();
    registerMessageHandlers(bot, built);
    registerCallbackHandlers(bot, built);
    await bot._handlers.get("callback_query")!(makeCallbackCtx("co"));
    await bot._handlers.get("callback_query")!(makeCallbackCtx("pm:c"));
    await bot._handlers.get("message:photo")!(makeMediaCtx("photo"));
    const order = built.orders.latestOrderFor(555);
    if (!order) throw new Error("order not placed");
    return { app: built, orderId: order.id, orderNumber: order.orderNumber };
  }

  test("a non-admin pressing the review buttons is refused", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerCallbackHandlers(bot, built.app);
    const ctx = makeCallbackCtx(`oa:yes:${built.orderId}`, 999);
    await bot._handlers.get("callback_query")!(ctx);

    expect(ctx._answers.some((a) => a?.show_alert && a?.text?.includes("غیرمجاز"))).toBe(true);
    expect(built.app.orders.loadOrder(built.orderId)!.paymentStatus).toBe("receipt_received");
  });

  test("admin تأیید marks the order paid and notifies the customer once", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerCallbackHandlers(bot, built.app);
    const ctx = makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN);
    await bot._handlers.get("callback_query")!(ctx);

    const order = built.app.orders.loadOrder(built.orderId)!;
    expect(order.paymentStatus).toBe("paid");
    expect(order.paymentReviewedBy).toBe(ADMIN);
    expect(ctx._answers.some((a) => a?.text?.includes("تأیید شد"))).toBe(true);
    // Buttons stripped so the resolved message cannot be re-pressed.
    expect(ctx._edits.length).toBeGreaterThan(0);

    const rows = built.app.db
      .query("SELECT * FROM notifications WHERE kind = 'customer_notice' AND ref_key = ?")
      .all(`payment_approved_${built.orderNumber}`) as any[];
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payload).text).toContain("تأیید شد");

    // A second press is a no-op — no duplicate customer notice.
    await bot._handlers.get("callback_query")!(makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN));
    const after = built.app.db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'customer_notice' AND ref_key = ?")
      .get(`payment_approved_${built.orderNumber}`) as { c: number };
    expect(after.c).toBe(1);
  });

  test("admin تأیید rewrites the receipt message caption and strips the keyboard", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerCallbackHandlers(bot, built.app);
    const ctx = makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN);
    await bot._handlers.get("callback_query")!(ctx);

    const captionEdit = ctx._edits.find((e) => e.kind === "caption");
    expect(captionEdit).toBeDefined();
    expect(captionEdit!.text).toContain(built.orderNumber);
    expect(captionEdit!.text).toContain("تأییدشده");
    expect(captionEdit!.text).not.toContain("تأییدنشده");
    // The inline keyboard is removed in the same edit.
    expect(captionEdit!.opts?.reply_markup?.inline_keyboard).toEqual([]);
  });

  test("a failing caption edit still strips the keyboard and keeps the order paid", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerCallbackHandlers(bot, built.app);
    const ctx = makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN);
    ctx.editMessageCaption = async () => {
      throw new Error("message can't be edited");
    };
    await bot._handlers.get("callback_query")!(ctx);

    // The database is the source of truth: approval stands despite the edit failure.
    expect(built.app.orders.loadOrder(built.orderId)!.paymentStatus).toBe("paid");
    // Fallback: the keyboard is still removed.
    expect(ctx._edits.some((e) => e.kind === "markup")).toBe(true);
  });

  test("a repeated تأیید press self-heals the caption without a duplicate notice", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerCallbackHandlers(bot, built.app);
    const first = makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN);
    await bot._handlers.get("callback_query")!(first);
    const second = makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN);
    await bot._handlers.get("callback_query")!(second);

    // Idempotent: still paid, and the second press re-applies the approved caption.
    expect(built.app.orders.loadOrder(built.orderId)!.paymentStatus).toBe("paid");
    const captionEdit = second._edits.find((e) => e.kind === "caption");
    expect(captionEdit).toBeDefined();
    expect(captionEdit!.text).toContain("تأییدشده");
    // No duplicate customer notification on the repeat press.
    const rows = built.app.db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'customer_notice' AND ref_key = ?")
      .get(`payment_approved_${built.orderNumber}`) as { c: number };
    expect(rows.c).toBe(1);
  });

  test("admin لغو asks for a reason; the typed reason is saved and sent to the customer with the receipt image", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerMessageHandlers(bot, built.app);
    registerCallbackHandlers(bot, built.app);

    const press = makeCallbackCtx(`oa:no:${built.orderId}`, ADMIN);
    await bot._handlers.get("callback_query")!(press);
    // Nothing is rejected yet — the reason is captured from the next text.
    expect(built.app.orders.loadOrder(built.orderId)!.paymentStatus).toBe("receipt_received");
    expect(built.app.rejectReasonFlow.isActive(ADMIN)).toBe(true);
    expect(press._replies.some((r) => r.text.includes("دلیل"))).toBe(true);

    const reasonCtx = fakeCtx("مبلغ واریزی کمتر از مبلغ سفارش است", {
      id: ADMIN,
      first_name: "Admin",
    });
    await bot._handlers.get("message:text")!(reasonCtx);

    const order = built.app.orders.loadOrder(built.orderId)!;
    expect(order.paymentStatus).toBe("rejected");
    expect(order.rejectionReason).toBe("مبلغ واریزی کمتر از مبلغ سفارش است");
    expect(order.paymentReviewedBy).toBe(ADMIN);
    expect(built.app.rejectReasonFlow.isActive(ADMIN)).toBe(false);

    // Customer notice: receipt image + reason text in one payload.
    const rows = built.app.db
      .query("SELECT * FROM notifications WHERE kind = 'customer_notice' AND ref_key = ?")
      .all(`payment_rejected_${built.orderNumber}`) as any[];
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.photoFileId).toBe("receipt-file");
    expect(payload.text).toContain("مبلغ واریزی کمتر از مبلغ سفارش است");
    expect(reasonCtx._replies.some((r) => r.text.includes("برای مشتری ارسال شد"))).toBe(true);
  });

  test("/cancel mid-reason clears the flow without rejecting the order", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerMessageHandlers(bot, built.app);
    registerCallbackHandlers(bot, built.app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx(`oa:no:${built.orderId}`, ADMIN));

    const cancelCtx = fakeCtx("/cancel", { id: ADMIN, first_name: "Admin" });
    await bot._handlers.get("message:text")!(cancelCtx);

    expect(built.app.rejectReasonFlow.isActive(ADMIN)).toBe(false);
    const order = built.app.orders.loadOrder(built.orderId)!;
    expect(order.paymentStatus).toBe("receipt_received");
    expect(order.rejectionReason).toBeNull();
  });

  test("لغو on an already-paid order is refused and does not arm the flow", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerCallbackHandlers(bot, built.app);
    await bot._handlers.get("callback_query")!(makeCallbackCtx(`oa:yes:${built.orderId}`, ADMIN));

    const ctx = makeCallbackCtx(`oa:no:${built.orderId}`, ADMIN);
    await bot._handlers.get("callback_query")!(ctx);
    expect(ctx._answers.some((a) => a?.show_alert)).toBe(true);
    expect(built.app.rejectReasonFlow.isActive(ADMIN)).toBe(false);
    expect(built.app.orders.loadOrder(built.orderId)!.paymentStatus).toBe("paid");
  });

  test("a customer's normal text is unaffected while no reject flow is active", async () => {
    const built = await placeCardOrder();
    const bot = fakeBot();
    registerMessageHandlers(bot, built.app);
    // No flow armed: an admin's free text must not be swallowed as a reason.
    const ctx = fakeCtx("سلام", { id: ADMIN, first_name: "Admin" });
    await bot._handlers.get("message:text")!(ctx);
    expect(built.app.orders.loadOrder(built.orderId)!.paymentStatus).toBe("receipt_received");
  });
});
