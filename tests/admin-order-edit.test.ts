/* Task 3: admin order detail loading, editing, status transitions.
 * Exercises the real service + HTTP boundary (same harness style as
 * admin-http.test.ts): GET/PUT /api/admin/orders/:ref and the existing
 * confirm/deliver lifecycle routes. */
import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { loadConfig } from "../src/config";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { updatePaymentSettings } from "../src/services/settings";
import { BusinessHoursService } from "../src/services/business-hours";
import { ReportService } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";
import { ChannelMembershipService } from "../src/services/membership";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import type { ApiApp } from "../src/api/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: Db;
let app: ApiApp;
const BOT_TOKEN = "123456:TEST-ADM-TOKEN";
const ADMIN = { id: 777, first_name: "Admin" };
const OTHER = { id: 999, first_name: "Bob" };
const NOW_S = () => Math.floor(Date.now() / 1000);

function headersFor(user: typeof ADMIN): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-telegram-init-data": signInitData(BOT_TOKEN, user as any, NOW_S()),
  };
}

function call(
  method: string,
  path: string,
  opts: { user?: typeof ADMIN | typeof OTHER | null; body?: unknown } = {},
) {
  const user = opts.user === undefined ? ADMIN : opts.user;
  const headers = user ? headersFor(user) : {};
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return handleAdminApi(new Request(`http://localhost${path}`, { method, headers, body }), app).then(
    async (r) => ({ status: r!.status, body: await r!.json() }),
  );
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
  };
});

function seedMenu() {
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  const cat = app.menu.createCategory({ name: "نوشیدنی" });
  const espresso = app.menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 });
  const latte = app.menu.createProduct({ categoryId: cat.id, name: "لاته", fixedPriceAmount: 120000 });
  return { espresso, latte };
}

/** Place a card-to-card order exactly like the customer checkout does. */
function placeCardOrder(productId: number, quantity = 1, telegramId = 555) {
  const cart = new CartService(db);
  cart.addItem(telegramId, productId, null, quantity);
  app.orders.startCheckout(telegramId);
  app.orders.choosePaymentMethod(telegramId, "card_to_card");
  const placed = app.orders.placeOrderAfterReceipt(telegramId, "receipt-file", 42);
  if (!placed.ok) throw new Error(`order not placed: ${JSON.stringify(placed)}`);
  return placed.order;
}

/** Place a wallet-funded order (balance funded up-front, like a real top-up). */
function placeWalletOrder(productId: number, quantity = 1, telegramId = 555) {
  updatePaymentSettings(db, {
    cardNumber: "603799",
    cardholderName: "Ali",
    currency: "تومان",
    walletEnabled: true,
  });
  app.customers.saveProfile(telegramId, { fullName: "مشتری" });
  app.customers.adjustBalance(telegramId, 500_000, null, ADMIN.id);
  const cart = new CartService(db);
  cart.addItem(telegramId, productId, null, quantity);
  app.orders.startCheckout(telegramId);
  const choose = app.orders.choosePaymentMethod(telegramId, "wallet");
  if (!choose.ok) throw new Error(choose.error);
  cart.setFulfillmentMethod(telegramId, "pickup");
  const placed = app.orders.confirmOrder(telegramId, "مشتری");
  if (!placed.ok) throw new Error(`wallet order not placed: ${JSON.stringify(placed)}`);
  return placed.order;
}

const enc = encodeURIComponent;

describe("admin order detail loading (customer profile + reports)", () => {
  test("GET by order number returns the full detail DTO; unknown -> 404", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 2);

    const r = await call("GET", `/api/admin/orders/${enc(order.orderNumber)}`);
    expect(r.status).toBe(200);
    expect(r.body.orderNumber).toBe(order.orderNumber);
    expect(r.body.fulfillmentStatus).toBe("pending");
    expect(r.body.fulfillmentLabel).toBeTruthy();
    expect(r.body.statusLabel).toBeTruthy();
    expect(r.body.paymentStatus).toBe("receipt_received");
    expect(r.body.hasReceipt).toBe(true);
    expect(r.body.totalAmount).toBe(160000);
    expect(r.body.items).toHaveLength(1);
    // Catalog ids needed by the edit form are exposed; DB/Telegram ids are not.
    expect(r.body.items[0].productId).toBe(espresso.id);
    expect(r.body.items[0].variantId).toBeNull();
    expect(r.body.id).toBeUndefined();
    expect(r.body.customerTelegramId).toBeUndefined();

    const missing = await call("GET", `/api/admin/orders/${enc("CN-19990101-9999")}`);
    expect(missing.status).toBe(404);
  });

  test("the customer profile list carries the same editable shape", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1, 555);
    const r = await call("GET", "/api/admin/customers/555");
    expect(r.status).toBe(200);
    const listed = (r.body.orders as any[]).find((o) => o.orderNumber === order.orderNumber);
    expect(listed).toBeDefined();
    expect(listed.fulfillmentStatus).toBe("pending");
    expect(listed.items[0].productId).toBe(espresso.id);
  });
});

describe("admin order editing", () => {
  test("items are replaced, repriced and persisted; the list view agrees", async () => {
    const { espresso, latte } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);

    const r = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: {
        items: [
          { productId: espresso.id, variantId: null, quantity: 1 },
          { productId: latte.id, variantId: null, quantity: 2 },
        ],
        deliveryTime: "فردا ساعت ۱۰",
        deliveryNotes: "بدون قند",
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.order.totalAmount).toBe(80000 + 2 * 120000);
    expect(r.body.order.items).toHaveLength(2);
    expect(r.body.order.deliveryTime).toBe("فردا ساعت ۱۰");
    expect(r.body.order.deliveryNotes).toBe("بدون قند");

    // Persistence: a fresh fetch (close/reopen the dialog) shows the same data.
    const fresh = await call("GET", `/api/admin/orders/${enc(order.orderNumber)}`);
    expect(fresh.body.totalAmount).toBe(320000);
    expect(fresh.body.deliveryTime).toBe("فردا ساعت ۱۰");

    // The customer profile's order list reflects it without a page reload path.
    const profile = await call("GET", "/api/admin/customers/555");
    const listed = (profile.body.orders as any[]).find((o) => o.orderNumber === order.orderNumber);
    expect(listed.totalAmount).toBe(320000);
  });

  test("edits revalidate against the live menu: current price wins", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    app.menu.updateProduct(espresso.id, { fixedPriceAmount: 90000 });
    const r = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: { items: [{ productId: espresso.id, variantId: null, quantity: 1 }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.order.totalAmount).toBe(90000);
    expect(r.body.order.items[0].unitPrice).toBe(90000);
  });

  test("inactive products are rejected and the order stays unchanged", async () => {
    const { espresso, latte } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    app.menu.updateProduct(latte.id, { active: false });
    const r = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: { items: [{ productId: latte.id, variantId: null, quantity: 1 }] },
    });
    expect(r.status).toBe(400);
    const fresh = await call("GET", `/api/admin/orders/${enc(order.orderNumber)}`);
    expect(fresh.body.totalAmount).toBe(80000);
    expect(fresh.body.items[0].productId).toBe(espresso.id);
  });

  test("delivery method needs a saved customer address", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    const denied = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: { fulfillmentMethod: "delivery" },
    });
    expect(denied.status).toBe(400);

    app.customers.saveProfile(555, { fullName: "مشتری", address: "تهران، خیابان آزادی" });
    const ok = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: { fulfillmentMethod: "delivery" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.order.fulfillmentMethod).toBe("delivery");
  });

  test("validation: empty items, bad quantities, duplicates, unknown product/order", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    const put = (body: unknown) =>
      call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, { body });

    expect((await put({ items: [] })).status).toBe(400);
    expect((await put({ items: [{ productId: espresso.id, variantId: null, quantity: 0 }] })).status).toBe(400);
    expect((await put({ items: [{ productId: espresso.id, variantId: null, quantity: 21 }] })).status).toBe(400);
    expect(
      (
        await put({
          items: [
            { productId: espresso.id, variantId: null, quantity: 1 },
            { productId: espresso.id, variantId: null, quantity: 1 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await put({ items: [{ productId: 99999, variantId: null, quantity: 1 }] })).status).toBe(400);
    expect((await put({ fulfillmentMethod: "teleport" })).status).toBe(400);

    const unknown = await call("PUT", `/api/admin/orders/${enc("CN-19990101-9999")}`, {
      body: { deliveryTime: "x" },
    });
    expect(unknown.status).toBe(400);
  });

  test("non-admin cannot read or edit orders", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    const read = await call("GET", `/api/admin/orders/${enc(order.orderNumber)}`, { user: OTHER });
    expect(read.status).toBe(403);
    const write = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      user: OTHER,
      body: { deliveryTime: "x" },
    });
    expect(write.status).toBe(403);
  });

  test("delivered orders are frozen", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    await call("POST", `/api/admin/orders/${enc(order.orderNumber)}/confirm`);
    await call("POST", `/api/admin/orders/${enc(order.orderNumber)}/deliver`);
    const r = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: { deliveryTime: "دیرتر" },
    });
    expect(r.status).toBe(400);
  });
});

describe("admin order status transitions", () => {
  test("pending -> confirmed -> delivered, with idempotent repeats", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    const path = `/api/admin/orders/${enc(order.orderNumber)}`;

    const c1 = await call("POST", `${path}/confirm`);
    expect(c1.status).toBe(200);
    expect(c1.body.already).toBe(false);
    expect(c1.body.order.fulfillmentStatus).toBe("confirmed");

    const c2 = await call("POST", `${path}/confirm`);
    expect(c2.status).toBe(200);
    expect(c2.body.already).toBe(true);

    const d1 = await call("POST", `${path}/deliver`);
    expect(d1.status).toBe(200);
    expect(d1.body.already).toBe(false);
    expect(d1.body.order.fulfillmentStatus).toBe("delivered");

    const d2 = await call("POST", `${path}/deliver`);
    expect(d2.status).toBe(200);
    expect(d2.body.already).toBe(true);

    // Invalid transitions are refused, not silently applied.
    expect((await call("POST", `${path}/confirm`)).status).toBe(400);

    // The detail endpoint agrees with the transitions (what the dialog shows).
    const fresh = await call("GET", path);
    expect(fresh.body.fulfillmentStatus).toBe("delivered");
  });

  test("deliver on a pending order is refused", async () => {
    const { espresso } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    const r = await call("POST", `/api/admin/orders/${enc(order.orderNumber)}/deliver`);
    expect(r.status).toBe(400);
  });
});

describe("wallet orders reconcile on edit", () => {
  test("raising and lowering the total charges/refunds the wallet exactly", async () => {
    const { espresso } = seedMenu();
    const order = placeWalletOrder(espresso.id, 1); // 80000; balance 420000
    expect(app.customers.getBalance(555)).toBe(420000);
    const path = `/api/admin/orders/${enc(order.orderNumber)}`;

    const up = await call("PUT", path, {
      body: { items: [{ productId: espresso.id, variantId: null, quantity: 2 }] },
    });
    expect(up.status).toBe(200);
    expect(up.body.order.totalAmount).toBe(160000);
    expect(app.customers.getBalance(555)).toBe(340000);

    const down = await call("PUT", path, {
      body: { items: [{ productId: espresso.id, variantId: null, quantity: 1 }] },
    });
    expect(down.status).toBe(200);
    expect(down.body.order.totalAmount).toBe(80000);
    expect(app.customers.getBalance(555)).toBe(420000);

    // A shortfall the balance cannot cover aborts the whole edit.
    const blocked = await call("PUT", path, {
      body: { items: [{ productId: espresso.id, variantId: null, quantity: 10 }] },
    });
    expect(blocked.status).toBe(400);
    const fresh = await call("GET", path);
    expect(fresh.body.totalAmount).toBe(80000);
    expect(app.customers.getBalance(555)).toBe(420000);

    // Customer summary tracks the reconciled order (no double-counting).
    const summary = app.customers.customerSummary(555);
    expect(summary.paidTotal).toBe(80000);
  });

  test("card-to-card edits do not touch the wallet", async () => {
    const { espresso, latte } = seedMenu();
    const order = placeCardOrder(espresso.id, 1);
    // adjustBalance requires a profile row (manual top-ups are for known customers).
    app.customers.saveProfile(555, { fullName: "مشتری" });
    app.customers.adjustBalance(555, 100_000, null, ADMIN.id);
    const r = await call("PUT", `/api/admin/orders/${enc(order.orderNumber)}`, {
      body: { items: [{ productId: latte.id, variantId: null, quantity: 3 }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.order.totalAmount).toBe(360000);
    expect(app.customers.getBalance(555)).toBe(100000);
  });
});
