import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { NotificationService } from "../src/services/notifications";
import { ChannelMembershipService } from "../src/services/membership";
import { ReferralService } from "../src/services/referrals";
import { TokenService } from "../src/bot/tokens";
import { TextCaptureFlow, type BotApp } from "../src/bot/context";
import { createMockAiService, type AiInput } from "../src/services/ollama";
import { registerCallbackHandlers } from "../src/bot/handlers/callbacks";
import { registerMessageHandlers } from "../src/bot/handlers/messages";
import { normalizeCardNumber, validateCardNumber, maskCardNumber, luhnCheck } from "../src/utils/cards";
import { loadConfig } from "../src/config";

const CONFIG = loadConfig({
  BOT_TOKEN: "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ",
  ADMIN_IDS: "777",
  APP_BASE_URL: "https://cafe.example.com",
});

const VALID_CARD = "6037991234567893"; // Luhn-valid test number
const VALID_CARD_2 = "9919123456789016";

// ---------------------------------------------------------------------------
// Card utils + CustomersService storage
// ---------------------------------------------------------------------------

describe("card utils", () => {
  test("normalizes Persian/Arabic digits and separators", () => {
    expect(normalizeCardNumber("۶۰۳۷-۹۹۱۲-۳۴۵۶-۷۸۹۳")).toBe(VALID_CARD);
    expect(normalizeCardNumber("6037 9912 3456 7893")).toBe(VALID_CARD);
    expect(normalizeCardNumber("٦٠٣٧٩٩١٢٣٤٥٦٧٨٩٣")).toBe(VALID_CARD);
  });

  test("validates length and Luhn", () => {
    expect(validateCardNumber(VALID_CARD)).toBe(VALID_CARD);
    expect(validateCardNumber("603799123456789")).toBeNull(); // 15 digits
    expect(validateCardNumber("6037991234567890")).toBeNull(); // Luhn fail
    expect(validateCardNumber("not-a-card!!")).toBeNull();
    expect(luhnCheck(VALID_CARD)).toBe(true);
  });

  test("masks without exposing the full number", () => {
    expect(maskCardNumber(VALID_CARD)).toBe("**** **** **** 7893");
  });
});

describe("customer card storage", () => {
  let db: Db;
  let customers: CustomersService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    customers = new CustomersService(db);
  });

  test("registers, reads masked, and replaces a card", () => {
    const r = customers.saveCard(555, VALID_CARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.masked).toBe("**** **** **** 7893");

    const card = customers.getCard(555)!;
    expect(card.last4).toBe("7893");
    expect(card.masked).toBe("**** **** **** 7893");

    const r2 = customers.saveCard(555, VALID_CARD_2);
    expect(r2.ok).toBe(true);
    expect(customers.getCard(555)!.last4).toBe("9016");
  });

  test("rejects invalid numbers without overwriting the saved card", () => {
    customers.saveCard(555, VALID_CARD);
    expect(customers.saveCard(555, "1234").ok).toBe(false);
    expect(customers.saveCard(555, "6037991234567890").ok).toBe(false); // Luhn fail
    expect(customers.saveCard(555, "abcd-efgh-ijkl-mnop").ok).toBe(false);
    expect(customers.getCard(555)!.last4).toBe("7893"); // untouched
  });

  test("one customer cannot see or affect another's card", () => {
    customers.saveCard(555, VALID_CARD);
    expect(customers.getCard(666)).toBeNull();
    customers.saveCard(666, VALID_CARD_2);
    expect(customers.getCard(555)!.last4).toBe("7893");
    expect(customers.getCard(666)!.last4).toBe("9016");
  });

  test("stores the normalized form, not the user's formatting", () => {
    customers.saveCard(555, "۶۰۳۷-۹۹۱۲-۳۴۵۶-۷۸۹۳");
    const row = db.query("SELECT card_number FROM customer_cards WHERE telegram_id = 555").get() as {
      card_number: string;
    };
    expect(row.card_number).toBe(VALID_CARD);
  });
});

// ---------------------------------------------------------------------------
// Bot card wizard flow
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
    api: {
      setChatMenuButton: async () => ({ ok: true, result: true }),
    },
    _commands: commands,
    _handlers: handlers,
  };
}

function flowCtx(text: string, userId = 555) {
  const replies: { text: string; opts?: any }[] = [];
  return {
    from: { id: userId, username: "customer", first_name: "Cust", last_name: null, language_code: "fa" },
    message: { text, message_id: 1 },
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
    from: { id: userId, username: "customer", first_name: "Cust", last_name: null, language_code: "fa" },
    callbackQuery: { data, id: "cbq" },
    message: { message_id: 2 },
    reply: async (t: string, opts?: any) => {
      replies.push({ text: t, opts });
      return {} as any;
    },
    answerCallbackQuery: async (o?: any) => {
      answers.push(o ?? {});
      return {} as any;
    },
    _replies: replies,
    _answers: answers,
  };
}

describe("bot card wizard", () => {
  let db: Db;
  let app: BotApp;
  let bot: ReturnType<typeof fakeBot>;
  let aiInputs: AiInput[];

  beforeEach(() => {
    db = openDatabase(":memory:");
    aiInputs = [];
    const businessHours = new BusinessHoursService(db, CONFIG.timezone);
    const menu = new MenuService(db);
    const cart = new CartService(db);
    const orders = new OrdersService(db, businessHours);
    app = {
      db,
      config: CONFIG,
      menu,
      cart,
      orders,
      businessHours,
      ai: createMockAiService((input) => {
        aiInputs.push(input);
        return { type: "chat", reply: "AI", actions: [], needsClarification: false };
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
      cardEdit: new TextCaptureFlow(),
    };
    bot = fakeBot();
    registerCallbackHandlers(bot, app);
    registerMessageHandlers(bot, app);
    app.customers.saveProfile(555, { fullName: "علی" });
  });

  const press = (data: string, userId = 555) => {
    const ctx = cbCtx(data, userId);
    return bot._handlers.get("callback_query")!(ctx).then(() => ctx);
  };
  const send = (text: string, userId = 555) => {
    const ctx = flowCtx(text, userId);
    return bot._handlers.get("message:text")!(ctx).then(() => ctx);
  };

  test("register a card end-to-end without reaching the AI", async () => {
    const menuCtx = await press("card");
    expect(menuCtx._replies[0].text).toContain("کارت بانکی من");
    expect(menuCtx._replies[0].text).toContain("ثبت نکرده‌اید");

    const editCtx = await press("cardedit");
    expect(editCtx._replies[0].text).toContain("۱۶ رقمی");
    expect(app.cardEdit.isActive(555)).toBe(true);

    const saved = await send(VALID_CARD);
    expect(app.cardEdit.isActive(555)).toBe(false);
    expect(saved._replies[0].text).toContain("ثبت شد");
    expect(saved._replies[0].text).toContain("7893");
    expect(app.customers.getCard(555)!.last4).toBe("7893");
    expect(aiInputs.length).toBe(0); // the flow swallowed the text before AI
  });

  test("invalid input re-asks and does not overwrite the saved card", async () => {
    app.customers.saveCard(555, VALID_CARD);
    await press("cardedit");
    // Existing card → confirmation step first; accept it.
    expect(app.cardEdit.isActive(555)).toBe(false); // not armed until cd:go
    await press("cd:go");
    expect(app.cardEdit.isActive(555)).toBe(true);

    const bad = await send("1234");
    expect(app.cardEdit.isActive(555)).toBe(true); // re-armed for retry
    expect(bad._replies[0].text).toContain("معتبر نیست");
    expect(app.customers.getCard(555)!.last4).toBe("7893"); // unchanged

    const good = await send(VALID_CARD_2);
    expect(app.cardEdit.isActive(555)).toBe(false);
    expect(good._replies[0].text).toContain("9016");
    expect(app.customers.getCard(555)!.last4).toBe("9016");
  });

  test("cancel button aborts without changing the card", async () => {
    app.customers.saveCard(555, VALID_CARD);
    await press("cardedit");
    await press("cd:go");
    expect(app.cardEdit.isActive(555)).toBe(true);
    const ctx = await press("cd:cancel");
    expect(app.cardEdit.isActive(555)).toBe(false);
    expect(ctx._replies.some((r: any) => r.text.includes("لغو شد"))).toBe(true);
    expect(app.customers.getCard(555)!.last4).toBe("7893");
  });

  test("/cancel clears an armed card flow", async () => {
    await press("cardedit"); // no existing card → armed immediately
    expect(app.cardEdit.isActive(555)).toBe(true);
    await send("/cancel");
    expect(app.cardEdit.isActive(555)).toBe(false);
  });

  test("state is isolated per user", async () => {
    await press("cardedit", 555);
    expect(app.cardEdit.isActive(555)).toBe(true);
    expect(app.cardEdit.isActive(666)).toBe(false);
    const other = await send("9999", 666); // not in a flow → normal text path
    expect(app.cardEdit.isActive(555)).toBe(true); // user 555 unaffected
    void other;
  });

  test("shows masked card on the view menu once registered", async () => {
    app.customers.saveCard(555, VALID_CARD);
    const ctx = await press("card");
    expect(ctx._replies[0].text).toContain("**** **** **** 7893");
    expect(ctx._replies[0].text).not.toContain(VALID_CARD); // never the full number
  });
});
