import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
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
import { ChannelMembershipService } from "../src/services/membership";
import { ReferralService } from "../src/services/referrals";
import { ReportService } from "../src/services/reports";
import { updatePaymentSettings, updateReportSettings } from "../src/services/settings";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import type { ApiApp } from "../src/api/context";
import { Scheduler } from "../src/scheduler";
import { TokenService } from "../src/bot/tokens";
import { TextCaptureFlow } from "../src/bot/context";
import { createMockAiService, type AiResult } from "../src/services/ollama";
import { registerMessageHandlers } from "../src/bot/handlers/messages";
import { registerCallbackHandlers } from "../src/bot/handlers/callbacks";
import type { BotApp } from "../src/bot/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end order lifecycle verification (Task 4): the receipt → review →
 * fulfillment chain across the customer flow, the admin API, the scheduler
 * delivery of receipt notices, and the bot keyboards. Telegram is always
 * mocked; SQLite is always real.
 */

const BOT_TOKEN = "123456:TEST-LIFECYCLE-TOKEN";
const ADMIN = { id: 777, first_name: "Admin" };
const NOW_S = () => Math.floor(Date.now() / 1000);

// Default seed: Sun–Thu + Sat 08:00–18:00 Asia/Tehran; Friday closed.
// 2026-10-12 is a Monday, 2026-10-16 a Friday (closed), 2026-10-17 a Saturday.
const MONDAY_OPEN = new Date("2026-10-12T10:00:00+03:30");
const FRIDAY_CLOSED = new Date("2026-10-16T12:00:00+03:30");
const SATURDAY_AFTER_CLOSE = new Date("2026-10-17T19:00:00+03:30");

let db: Db;
let app: ApiApp;
let cart: CartService;
let espressoId: number;
let waterId: number;

function headersFor(user: typeof ADMIN): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-telegram-init-data": signInitData(BOT_TOKEN, user as any, NOW_S()),
  };
}

function call(
  method: string,
  path: string,
  opts: { body?: unknown } = {},
) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return handleAdminApi(
    new Request(`http://localhost${path}`, { method, headers: headersFor(ADMIN), body }),
    app,
  ).then(async (r) => ({ status: r!.status, body: await r!.json() }));
}

beforeEach(() => {
  db = openDatabase(":memory:");
  const config = loadConfig({
    BOT_TOKEN,
    ADMIN_IDS: "777",
    TIMEZONE: "Asia/Tehran",
    APP_BASE_URL: "https://cafe.example.com",
  });
  const businessHours = new BusinessHoursService(db, config.timezone);
  const menu = new MenuService(db);
  const orders = new OrdersService(db, businessHours);
  const notifications = new NotificationService(db);
  const reports = new ReportService(db, businessHours, notifications, config.timezone);
  cart = new CartService(db);
  app = {
    config,
    db,
    menu,
    orders,
    businessHours,
    reports,
    notifications,
    uploadsDir: mkdtempSync(join(tmpdir(), "cafe-uploads-")),
    customers: new CustomersService(db),
    loyalty: new LoyaltyService(db),
    membership: new ChannelMembershipService(db),
    referrals: new ReferralService(db),
  };
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  // Recipients drive the immediate receipt-review notifications; the daily
  // report itself stays off so scheduler ticks don't enqueue missed-run reports.
  updateReportSettings(db, { enabled: false, time: "18:30", sendEmpty: true, recipients: [777] }, new Set([777]));
  const cat = menu.createCategory({ name: "نوشیدنی" });
  espressoId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 }).id;
  waterId = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 }).id;
});

afterEach(() => {
  setSystemTime();
});

/** Place a card-to-card order exactly like the receipt handler does. */
function placeCardOrder(userId = 555, qty = 1, productId = waterId) {
  cart.addItem(userId, productId, null, qty);
  app.orders.startCheckout(userId);
  app.orders.choosePaymentMethod(userId, "card_to_card");
  const placed = app.orders.placeOrderAfterReceipt(userId, "receipt-file", 42, "مشتری");
  if (!placed.ok) throw new Error(`order not placed: ${JSON.stringify(placed)}`);
  return placed.order;
}

/** Mock bot whose receipt photo delivery is recorded with a fixed message id. */
function mockSchedulerBot(sent: { chatId: number; fileId: string; caption?: string }[], photoMessageId = 900) {
  return {
    api: {
      sendMessage: async () => ({ message_id: 1 }),
      sendPhoto: async (chatId: number, fileId: string, other: any) => {
        sent.push({ chatId, fileId, caption: other?.caption });
        return { message_id: photoMessageId };
      },
      getFile: async () => ({ file_path: "photos/receipt.jpg" }),
      editMessageCaption: async () => true,
    },
  };
}

// ---------- bot-level harness (Scenario B keyboards + slot presses) ----------

function fakeBot() {
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  return {
    command() {},
    on(event: string, h: (ctx: any) => Promise<void>) {
      handlers.set(event, h);
    },
    api: { setChatMenuButton: async () => ({ ok: true, result: true }) },
    _handlers: handlers,
  };
}

function makeCallbackCtx(data: string, userId = 555) {
  const answers: any[] = [];
  const replies: { text: string; opts?: any }[] = [];
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
      replies.push({ text: t, opts });
      return {} as any;
    },
    editMessageCaption: async () => ({} as any),
    editMessageReplyMarkup: async () => ({} as any),
    _answers: answers,
    _replies: replies,
  };
}

function makePhotoCtx(userId = 555) {
  const replies: { text: string; opts?: any }[] = [];
  return {
    from: { id: userId, first_name: "Cust" },
    message: {
      message_id: 42,
      photo: [
        { file_id: "small", file_size: 100 },
        { file_id: "receipt-file", file_size: 2048 },
      ],
    },
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

function buildBotApp(): BotApp {
  const menu = new MenuService(db);
  const businessHours = new BusinessHoursService(db, app.config.timezone);
  const cart = new CartService(db);
  return {
    db,
    config: app.config,
    menu,
    cart,
    orders: new OrdersService(db, businessHours),
    businessHours,
    ai: createMockAiService((): AiResult => ({ type: "chat", reply: "ok", actions: [], needsClarification: false })),
    tokens: new TokenService(db),
    history: new Map(),
    persona: "",
    customers: app.customers,
    loyalty: app.loyalty,
    membership: new ChannelMembershipService(db),
    referrals: new ReferralService(db),
    notifications: app.notifications,
    profileEdit: new TextCaptureFlow(),
    depositFlow: new TextCaptureFlow(),
    rejectReasonFlow: new TextCaptureFlow(),
    referralFlow: new TextCaptureFlow(),
  };
}

// ================================ Scenario A ================================

describe("Scenario A: normal customer order while open", () => {
  test("receipt → admin visibility → approve → confirm → deliver keeps every view in sync", async () => {
    setSystemTime(MONDAY_OPEN);
    const order = placeCardOrder(555, 2); // 2 × 15,000

    // Slot selection while open («الان» semantics: a concrete time can be set).
    const slot = app.orders.updateFulfillment(order.id, 555, { time: "همین الان" });
    expect(slot.ok).toBe(true);

    // The receipt is visible in the admin panel: detail by order number.
    const detail = await call("GET", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.hasReceipt).toBe(true);
    expect(detail.body.paymentStatus).toBe("receipt_received");
    expect(detail.body.fulfillmentStatus).toBe("pending");
    expect(detail.body.deliveryTime).toBe("همین الان");
    expect(detail.body.totalAmount).toBe(30000);

    // The scheduler delivered the receipt notice and recorded its message id.
    const sent: { chatId: number; fileId: string; caption?: string }[] = [];
    const scheduler = new Scheduler({
      db,
      bot: mockSchedulerBot(sent) as any,
      reports: app.reports,
      notifications: app.notifications,
      businessHours: app.businessHours,
      orders: app.orders,
    });
    await scheduler.tick();
    expect(sent.some((s) => s.fileId === "receipt-file")).toBe(true);
    const notice = db
      .query(
        `SELECT recipient_id, notification_id, status FROM notifications
         WHERE kind = 'order_update' AND ref_key = ?`,
      )
      .get(order.orderNumber) as { recipient_id: number; notification_id: number; status: string };
    expect(notice.status).toBe("sent");
    expect(notice.notification_id).toBe(900); // migration 011 wired through the scheduler

    // Approve from the panel: the delivered Telegram notice is rewritten in place.
    const edits: { chatId: number; messageId: number; caption: string }[] = [];
    app.bot = {
      api: {
        getFile: async () => ({ file_path: "photos/receipt.jpg" }),
        editMessageCaption: async (chatId: number, messageId: number, other: { caption: string }) => {
          edits.push({ chatId, messageId, caption: other.caption });
          return true;
        },
      },
    };
    const approve = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/payment/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.order.paymentStatus).toBe("paid");
    expect(edits.length).toBe(1);
    expect(edits[0]!.chatId).toBe(777);
    expect(edits[0]!.messageId).toBe(900);
    expect(edits[0]!.caption).toContain("تأییدشده");

    // The order list and the detail view both reflect the approved state.
    const list = await call("GET", `/api/admin/orders?businessDate=${order.businessDate}`);
    const row = (list.body as any[]).find((o) => o.orderNumber === order.orderNumber);
    expect(row.paymentStatus).toBe("paid");
    const afterApprove = await call("GET", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`);
    expect(afterApprove.body.paymentLabel).toBe("پرداخت شده");

    // Fulfillment lifecycle: pending → confirmed → delivered.
    const confirm = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/confirm`);
    expect(confirm.body.order.fulfillmentStatus).toBe("confirmed");
    expect(confirm.body.already).toBe(false);
    const deliver = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/deliver`);
    expect(deliver.body.order.fulfillmentStatus).toBe("delivered");
    const final = await call("GET", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`);
    expect(final.body.fulfillmentStatus).toBe("delivered");
    expect(final.body.fulfillmentLabel).toBe("تحویل شده");
  });

  test("a receipt image failure path never corrupts the order; success streams bytes", async () => {
    setSystemTime(MONDAY_OPEN);
    const order = placeCardOrder();
    const path = `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/receipt/image`;

    // No bot configured → 503, order untouched.
    const noBot = await call("GET", path);
    expect(noBot.status).toBe(503);
    expect(app.orders.loadOrder(order.id)!.paymentStatus).toBe("receipt_received");

    // getFile throws → 502, order untouched.
    app.bot = {
      api: {
        getFile: async () => {
          throw new Error("network down");
        },
        editMessageCaption: async () => true,
      },
    };
    const failed = await call("GET", path);
    expect(failed.status).toBe(502);
    expect(app.orders.loadOrder(order.id)!.paymentStatus).toBe("receipt_received");

    // A successful fetch streams image bytes. Restore the real global fetch —
    // deleting it would break later test files that hit a local server.
    app.bot = {
      api: {
        getFile: async () => ({ file_path: "photos/receipt.jpg" }),
        editMessageCaption: async () => true,
      },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })) as unknown as typeof fetch;
    try {
      const res = await handleAdminApi(
        new Request(`http://localhost${path}`, { method: "GET", headers: headersFor(ADMIN) }),
        app,
      );
      expect(res!.status).toBe(200);
      expect(new Uint8Array(await res!.arrayBuffer()).length).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ================================ Scenario B ================================

describe("Scenario B: order outside business hours", () => {
  test("while closed the fulfillment keyboard omits «الان» and offers only «فردا»", async () => {
    setSystemTime(FRIDAY_CLOSED);
    const botApp = buildBotApp();
    const cart = botApp.cart;
    cart.addItem(555, waterId, null, 1);
    botApp.orders.startCheckout(555);
    botApp.orders.choosePaymentMethod(555, "card_to_card");
    const bot = fakeBot();
    registerMessageHandlers(bot, botApp);
    const media = makePhotoCtx();
    await bot._handlers.get("message:photo")!(media);

    const summary = media._replies.find((r) => r.opts?.reply_markup)!;
    const keys = callbacksOf(summary.opts.reply_markup);
    expect(keys).not.toContain("ft:now");
    expect(keys).not.toContain("ft:5m");
    expect(keys).not.toContain("ft:10m");
    expect(keys).toContain("ft:tomorrow"); // the next-day slot is offered
  });

  test("while open the keyboard still offers الان and the quick slots", async () => {
    setSystemTime(MONDAY_OPEN);
    const botApp = buildBotApp();
    botApp.cart.addItem(555, waterId, null, 1);
    botApp.orders.startCheckout(555);
    botApp.orders.choosePaymentMethod(555, "card_to_card");
    const bot = fakeBot();
    registerMessageHandlers(bot, botApp);
    const media = makePhotoCtx();
    await bot._handlers.get("message:photo")!(media);

    const summary = media._replies.find((r) => r.opts?.reply_markup)!;
    const keys = callbacksOf(summary.opts.reply_markup);
    expect(keys).toContain("ft:now");
    expect(keys).toContain("ft:tomorrow");
    expect(keys).toContain("ft:5m");
    expect(keys).toContain("ft:10m");
  });

  test("a stale «الان» press while closed is refused and the order time is unchanged", async () => {
    setSystemTime(FRIDAY_CLOSED);
    const order = placeCardOrder();
    const botApp = buildBotApp();
    const bot = fakeBot();
    registerCallbackHandlers(bot, botApp);
    const press = makeCallbackCtx("ft:now");
    await bot._handlers.get("callback_query")!(press);

    expect(press._answers.some((a) => (a?.text ?? "").includes("بسته"))).toBe(true);
    expect(app.orders.loadOrder(order.id)!.deliveryTime).toBeNull();
    // The next-day slot still works.
    const tomorrow = makeCallbackCtx("ft:tomorrow");
    await bot._handlers.get("callback_query")!(tomorrow);
    expect(app.orders.loadOrder(order.id)!.deliveryTime).toBe("فردا");
  });

  test("typed «الان» while closed is refused; «فردا» is accepted", async () => {
    setSystemTime(FRIDAY_CLOSED);
    const order = placeCardOrder();
    const botApp = buildBotApp();
    const bot = fakeBot();
    registerMessageHandlers(bot, botApp);

    const nowCtx = {
      from: { id: 555, first_name: "Cust" },
      message: { text: "الان", message_id: 1 },
      reply: async (t: string) => ({}) as any,
      _texts: [] as string[],
    };
    nowCtx.reply = async (t: string) => {
      nowCtx._texts.push(t);
      return {} as any;
    };
    await bot._handlers.get("message:text")!(nowCtx);
    expect(nowCtx._texts.join("\n")).toContain("بسته");
    expect(app.orders.loadOrder(order.id)!.deliveryTime).toBeNull();

    const tomorrowCtx = {
      from: { id: 555, first_name: "Cust" },
      message: { text: "فردا", message_id: 2 },
      reply: async (t: string) => ({}) as any,
      _texts: [] as string[],
    };
    tomorrowCtx.reply = async (t: string) => {
      tomorrowCtx._texts.push(t);
      return {} as any;
    };
    await bot._handlers.get("message:text")!(tomorrowCtx);
    expect(app.orders.loadOrder(order.id)!.deliveryTime).toBe("فردا");
  });

  test("an order placed after closing rolls to the next active business date in the admin list", async () => {
    // Saturday 19:00 — after the 18:00 close; Sunday is the next active day.
    setSystemTime(SATURDAY_AFTER_CLOSE);
    const order = placeCardOrder();
    expect(order.businessDate).toBe("2026-10-18"); // Sunday
    const list = await call("GET", "/api/admin/orders?businessDate=2026-10-18");
    expect((list.body as any[]).some((o) => o.orderNumber === order.orderNumber)).toBe(true);
    // Friday-closed: an order on Friday lands on Saturday.
    setSystemTime(FRIDAY_CLOSED);
    const fridayOrder = placeCardOrder(666);
    expect(fridayOrder.businessDate).toBe("2026-10-17");
  });
});

// ================================ Scenario C ================================
//
// The deep edit/transition matrix (repricing, validation, frozen orders,
// wallet reconciliation, idempotent repeats) lives in
// tests/admin-order-edit.test.ts — audited and run as part of this task, not
// duplicated here. This test covers the profile close/reopen sync path.

describe("Scenario C: customer order management", () => {
  test("edit + status change persist; a reopened order and the customer list stay in sync", async () => {
    setSystemTime(MONDAY_OPEN);
    const order = placeCardOrder(555, 2); // 30,000

    // Step 4: edit an allowed field through the shared sheet's endpoint.
    const put = await call("PUT", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`, {
      body: { deliveryTime: "ساعت ۵ عصر", deliveryNotes: "بدون قند" },
    });
    expect(put.status).toBe(200);

    // Step 5: a valid transition (pending → confirmed).
    const confirm = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/confirm`);
    expect(confirm.body.order.fulfillmentStatus).toBe("confirmed");
    expect(confirm.body.already).toBe(false);

    // Steps 6–7: close and reopen (fresh GET by number) — changes persisted;
    // the customer-profile order list shows the same state.
    const reopened = await call("GET", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`);
    expect(reopened.body.deliveryTime).toBe("ساعت ۵ عصر");
    expect(reopened.body.deliveryNotes).toBe("بدون قند");
    expect(reopened.body.fulfillmentStatus).toBe("confirmed");

    const profile = await call("GET", "/api/admin/customers/555");
    const listed = (profile.body.orders as any[]).find((o) => o.orderNumber === order.orderNumber);
    expect(listed.deliveryTime).toBe("ساعت ۵ عصر");
    expect(listed.fulfillmentStatus).toBe("confirmed");
  });
});

// ================================ Scenario D ================================

describe("Scenario D: error handling and repeated actions", () => {
  test("a repeated API approval is idempotent and never double-notifies the customer", async () => {
    setSystemTime(MONDAY_OPEN);
    const order = placeCardOrder();
    const path = `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/payment/approve`;
    const r1 = await call("POST", path);
    expect(r1.body.already).toBe(false);
    const r2 = await call("POST", path);
    expect(r2.status).toBe(200);
    expect(r2.body.already).toBe(true);
    expect(r2.body.order.paymentStatus).toBe("paid");

    const notices = db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'customer_notice' AND ref_key = ?")
      .get(`payment_approved_${order.orderNumber}`) as { c: number };
    expect(notices.c).toBe(1);
  });

  test("reject-after-paid is refused; approve-after-reject is allowed", async () => {
    setSystemTime(MONDAY_OPEN);
    const order = placeCardOrder();
    const base = `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`;

    const reject = await call("POST", `${base}/payment/reject`, { body: { reason: "مبلغ کم است" } });
    expect(reject.status).toBe(200);
    expect(reject.body.order.paymentStatus).toBe("rejected");

    const rejectAgain = await call("POST", `${base}/payment/reject`, { body: { reason: "دوباره" } });
    expect(rejectAgain.body.already).toBe(true);

    // A corrected receipt can still be approved afterwards.
    const approve = await call("POST", `${base}/payment/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.order.paymentStatus).toBe("paid");
    const approveAgain = await call("POST", `${base}/payment/approve`);
    expect(approveAgain.body.already).toBe(true);

    const rejectAfterPaid = await call("POST", `${base}/payment/reject`, { body: { reason: "x" } });
    expect(rejectAfterPaid.status).toBe(400);
  });

  test("an invalid quick-time callback is refused as stale", async () => {
    setSystemTime(MONDAY_OPEN);
    placeCardOrder();
    const botApp = buildBotApp();
    const bot = fakeBot();
    registerCallbackHandlers(bot, botApp);
    const press = makeCallbackCtx("ft:whenever");
    await bot._handlers.get("callback_query")!(press);
    expect(press._answers.some((a) => a?.show_alert)).toBe(true);
    expect(app.orders.latestOrderFor(555)!.deliveryTime).toBeNull();
  });

  test("an order older than the customer edit window refuses fulfillment presses", async () => {
    setSystemTime(MONDAY_OPEN);
    const order = placeCardOrder();
    // Backdate past ORDER_EDIT_WINDOW_MS (15 min).
    db.query("UPDATE orders SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 16 * 60_000).toISOString(),
      order.id,
    );
    const botApp = buildBotApp();
    const bot = fakeBot();
    registerCallbackHandlers(bot, botApp);
    const press = makeCallbackCtx("ft:tomorrow");
    await bot._handlers.get("callback_query")!(press);
    expect(press._answers.some((a) => a?.show_alert)).toBe(true);
    expect(app.orders.loadOrder(order.id)!.deliveryTime).toBeNull();
    // The admin can still edit a pending order outside the customer window.
    const put = await call("PUT", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`, {
      body: { deliveryTime: "ساعت ۱۱" },
    });
    expect(put.status).toBe(200);
  });

  test("GET 404 vs PUT 400 for an unknown order number (documented inconsistency)", async () => {
    const get = await call("GET", "/api/admin/orders/CN-20990101-9999");
    expect(get.status).toBe(404);
    const put = await call("PUT", "/api/admin/orders/CN-20990101-9999", { body: { deliveryTime: "x" } });
    expect(put.status).toBe(400);
  });
});
