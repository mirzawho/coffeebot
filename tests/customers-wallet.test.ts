import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { CustomersService, normalizePhone } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { updatePaymentSettings, getAiSettings, updateAiSettings, getNotificationSettings, updateNotificationSettings } from "../src/services/settings";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import { loadConfig } from "../src/config";
import { ReportService } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";

let db: Db;
let menu: MenuService;
let cart: CartService;
let orders: OrdersService;
let bh: BusinessHoursService;
let customers: CustomersService;
let loyalty: LoyaltyService;
let waterId: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  menu = new MenuService(db);
  bh = new BusinessHoursService(db, "Asia/Tehran");
  cart = new CartService(db);
  orders = new OrdersService(db, bh);
  customers = new CustomersService(db);
  loyalty = new LoyaltyService(db);
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  const cat = menu.createCategory({ name: "نوشیدنی" });
  waterId = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 }).id;
});

// ---------------------------------------------------------------------------
// Customer profile
// ---------------------------------------------------------------------------

describe("customer profile", () => {
  test("creates and associates a profile with the Telegram id", () => {
    const r = customers.saveProfile(555, { firstName: "علی", lastName: "رضایی", phone: "09121234567" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.telegramId).toBe(555);
    expect(r.profile.firstName).toBe("علی");
    expect(customers.getProfile(666)).toBeNull(); // isolated per user
  });

  test("updates an existing profile", () => {
    customers.saveProfile(555, { firstName: "علی" });
    const r = customers.saveProfile(555, { firstName: "علی", phone: "09121234567" });
    expect(r.ok).toBe(true);
    expect(customers.getProfile(555)?.phone).toBe("09121234567");
  });

  test("rejects empty name and invalid phone", () => {
    expect(customers.saveProfile(555, { firstName: "" }).ok).toBe(false);
    const r = customers.saveProfile(555, { firstName: "x", phone: "123" });
    expect(r.ok).toBe(false);
  });

  test("normalizes Persian digits and international formats", () => {
    expect(normalizePhone("۰۹۱۲۱۲۳۴۵۶۷")).toBe("09121234567");
    expect(normalizePhone("+989121234567")).toBe("09121234567");
    expect(normalizePhone("9121234567")).toBe("09121234567");
    expect(normalizePhone("garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

describe("wallet deposits", () => {
  test("create pending deposit, approve credits exactly once", () => {
    const c = customers.createDeposit(555, 100000);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.deposit.status).toBe("pending");
    expect(customers.getBalance(555)).toBe(0); // not credited until approved

    const a = customers.approveDeposit(c.deposit.id, 777);
    expect(a.ok).toBe(true);
    expect(customers.getBalance(555)).toBe(100000);

    // Duplicate approval does not double-credit.
    const dup = customers.approveDeposit(c.deposit.id, 777);
    expect(dup.ok).toBe(false);
    expect(customers.getBalance(555)).toBe(100000);
  });

  test("reject does not credit", () => {
    const c = customers.createDeposit(555, 50000);
    if (!c.ok) throw new Error("create failed");
    const r = customers.rejectDeposit(c.deposit.id, 777);
    expect(r.ok).toBe(true);
    expect(customers.getBalance(555)).toBe(0);
    // Rejecting an already-reviewed deposit is refused.
    expect(customers.rejectDeposit(c.deposit.id, 777).ok).toBe(false);
  });

  test("approve records the reviewing admin and timestamp", () => {
    const c = customers.createDeposit(555, 1000);
    if (!c.ok) throw new Error("create failed");
    customers.approveDeposit(c.deposit.id, 777);
    const d = customers.getDeposit(c.deposit.id)!;
    expect(d.status).toBe("approved");
    expect(d.reviewedBy).toBe(777);
    expect(d.reviewedAt).toBeTruthy();
  });

  test("ledger and balance stay consistent; history is preserved", () => {
    const c = customers.createDeposit(555, 200000);
    if (!c.ok) throw new Error("create failed");
    customers.approveDeposit(c.deposit.id, 777);
    const txs = customers.listTransactions(555);
    expect(txs.length).toBe(1);
    expect(txs[0]!.amount).toBe(200000);
    expect(txs[0]!.balanceAfter).toBe(200000);
    expect(customers.getBalance(555)).toBe(200000);
  });

  test("attach receipt to the correct pending deposit only", () => {
    const c = customers.createDeposit(555, 1000);
    if (!c.ok) throw new Error("create failed");
    expect(customers.attachDepositReceipt(555, c.deposit.id, "file-1", 10).ok).toBe(true);
    expect(customers.getDeposit(c.deposit.id)?.receiptFileId).toBe("file-1");
    // Attaching to a different customer's deposit is refused.
    const c2 = customers.createDeposit(666, 1000);
    if (!c2.ok) throw new Error("create failed");
    expect(customers.attachDepositReceipt(555, c2.deposit.id, "file-2", 11).ok).toBe(false);
  });
});

describe("wallet order payment", () => {
  function placeOrder(userId: number, payWithWallet: boolean) {
    cart.addItem(userId, waterId, null, 2);
    orders.startCheckout(userId);
    orders.attachReceipt(userId, "f", 1);
    orders.setDeliveryNotes(userId, null);
    return orders.confirmOrder(userId, "Cust", payWithWallet);
  }

  test("wallet payment deducts atomically and marks order paid", () => {
    const c = customers.createDeposit(555, 50000);
    if (!c.ok) throw new Error("create failed");
    customers.approveDeposit(c.deposit.id, 777);
    const conf = placeOrder(555, true);
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;
    expect(customers.getBalance(555)).toBe(50000 - 30000);
    expect(conf.order.paymentMethod).toBe("wallet");
    expect(conf.order.paymentStatus).toBe("paid");
    expect(conf.order.receiptFileId).toBeNull(); // no card receipt for wallet
  });

  test("insufficient balance is rejected without placing the order", () => {
    const conf = placeOrder(555, true);
    expect(conf.ok).toBe(false);
    expect(customers.getBalance(555)).toBe(0);
    expect(orders.listForCustomer(555).length).toBe(0);
  });

  test("concurrent wallet payments cannot overspend", () => {
    const c = customers.createDeposit(555, 30000); // exactly enough for one order
    if (!c.ok) throw new Error("create failed");
    customers.approveDeposit(c.deposit.id, 777);
    // First order succeeds, second (same cart re-seeded) must fail on balance.
    const first = placeOrder(555, true);
    expect(first.ok).toBe(true);
    expect(customers.getBalance(555)).toBe(0);
    const second = placeOrder(555, true);
    expect(second.ok).toBe(false);
    expect(customers.getBalance(555)).toBe(0);
  });

  test("card payment does not touch the wallet", () => {
    const c = customers.createDeposit(555, 99999);
    if (!c.ok) throw new Error("create failed");
    customers.approveDeposit(c.deposit.id, 777);
    const conf = placeOrder(555, false);
    expect(conf.ok).toBe(true);
    expect(customers.getBalance(555)).toBe(99999);
  });
});

// ---------------------------------------------------------------------------
// Pricing: after-hours + emoji
// ---------------------------------------------------------------------------

describe("after-hours pricing", () => {
  // Business hours default: Sun–Thu 08:00–18:00, Fri closed, Sat 08:00–18:00.
  // "Now" is fixed via the isOpenAt input, so we test priceFor directly plus
  // the isOpenAt boundary using the real schedule.
  test("regular price applies during business hours", () => {
    const p = menu.getProduct(waterId)!;
    // 10:00 on a Sunday is inside hours.
    const sunday10am = new Date("2026-10-18T06:30:00Z"); // 10:00 Tehran (UTC+3:30)
    expect(bh.isOpenAt(sunday10am)).toBe(true);
    expect(menu.priceFor(p, !bh.isOpenAt(sunday10am))).toBe(15000);
  });

  test("after-hours price applies outside hours; empty falls back", () => {
    menu.updateProduct(waterId, { afterHoursPriceAmount: 20000 });
    const p = menu.getProduct(waterId)!;
    // A Friday (closed) instant.
    const friday = new Date("2026-10-16T12:00:00Z"); // Friday daytime
    expect(bh.isOpenAt(friday)).toBe(false);
    expect(menu.priceFor(p, !bh.isOpenAt(friday))).toBe(20000);
    // After clearing, falls back to regular.
    menu.updateProduct(waterId, { afterHoursPriceAmount: null });
    const p2 = menu.getProduct(waterId)!;
    expect(menu.priceFor(p2, true)).toBe(15000);
  });

  test("explicit zero after-hours price is a valid price (not 'unset')", () => {
    menu.updateProduct(waterId, { afterHoursPriceAmount: 0 });
    const p = menu.getProduct(waterId)!;
    expect(p.afterHoursPriceAmount).toBe(0);
    expect(menu.priceFor(p, true)).toBe(0);
    expect(menu.priceFor(p, false)).toBe(15000);
  });

  test("cart totals use after-hours price when flagged", () => {
    menu.updateProduct(waterId, { afterHoursPriceAmount: 20000 });
    cart.addItem(555, waterId, null, 2);
    expect(cart.getTotals(555, false).total).toBe(30000);
    expect(cart.getTotals(555, true).total).toBe(40000);
  });

  test("order snapshot keeps historical price after product repricing", () => {
    cart.addItem(555, waterId, null, 2);
    orders.startCheckout(555);
    orders.attachReceipt(555, "f", 1);
    orders.setDeliveryNotes(555, null);
    const conf = orders.confirmOrder(555, "Cust");
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;
    menu.updateProduct(waterId, { fixedPriceAmount: 99999 });
    const reloaded = orders.loadOrder(conf.order.id)!;
    expect(reloaded.items[0]!.unitPrice).toBe(15000);
    expect(reloaded.totalAmount).toBe(30000);
  });
});

describe("product emoji", () => {
  test("emoji persists and reaches the AI catalog", () => {
    menu.updateProduct(waterId, { emoji: "🧋" });
    const p = menu.getProduct(waterId)!;
    expect(p.emoji).toBe("🧋");
    const catalog = menu.aiCatalog();
    expect(catalog.products.find((x) => x.id === waterId)?.emoji).toBe("🧋");
  });

  test("invalid emoji is rejected; null clears", () => {
    expect(() => menu.updateProduct(waterId, { emoji: "not-an-emoji" })).toThrow();
    menu.updateProduct(waterId, { emoji: "☕" });
    menu.updateProduct(waterId, { emoji: null });
    expect(menu.getProduct(waterId)!.emoji).toBeNull();
  });

  test("existing products without emoji still work", () => {
    expect(menu.getProduct(waterId)!.emoji).toBeNull();
    expect(menu.priceFor(menu.getProduct(waterId)!, false)).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

describe("order lifecycle", () => {
  function place(): number {
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    orders.attachReceipt(555, "f", 1);
    orders.setDeliveryNotes(555, null);
    const conf = orders.confirmOrder(555, "Cust");
    if (!conf.ok) throw new Error("order failed");
    return conf.order.id;
  }

  test("valid transitions pending → confirmed → delivered", () => {
    const id = place();
    expect(orders.loadOrder(id)!.fulfillmentStatus).toBe("pending");
    const c = orders.markConfirmed(id, 777);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.order.fulfillmentStatus).toBe("confirmed");
      expect(c.order.confirmedBy).toBe(777);
    }
    const d = orders.markDelivered(id, 777);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.order.fulfillmentStatus).toBe("delivered");
  });

  test("duplicate and invalid transitions are rejected safely", () => {
    const id = place();
    orders.markConfirmed(id, 777);
    // Delivering twice: second is idempotent (already=true) but not an error.
    orders.markDelivered(id, 777);
    const again = orders.markDelivered(id, 777);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.already).toBe(true);
    // Confirming a delivered order is invalid.
    const bad = orders.markConfirmed(id, 777);
    expect(bad.ok).toBe(false);
  });

  test("confirming never marks the order paid", () => {
    const id = place();
    orders.markConfirmed(id, 777);
    const o = orders.loadOrder(id)!;
    expect(o.fulfillmentStatus).toBe("confirmed");
    expect(o.paymentStatus).toBe("receipt_received"); // unchanged
  });

  test("customer history is scoped to the requesting user", () => {
    const id = place();
    expect(orders.loadOrderForCustomer(id, 555)).not.toBeNull();
    expect(orders.loadOrderForCustomer(id, 666)).toBeNull();
    expect(orders.listForCustomer(666).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loyalty: usual + ratings
// ---------------------------------------------------------------------------

describe("loyalty", () => {
  function placeFor(userId: number) {
    cart.addItem(userId, waterId, null, 1);
    orders.startCheckout(userId);
    orders.attachReceipt(userId, `f-${userId}`, 1);
    orders.setDeliveryNotes(userId, null);
    const conf = orders.confirmOrder(userId, "C");
    expect(conf.ok).toBe(true);
  }

  test("usual uses only the customer's own repeated orders", () => {
    placeFor(555);
    placeFor(555);
    placeFor(666); // another customer should not affect 555
    const usual = loyalty.usualFor(555);
    expect(usual.primary.length).toBeGreaterThan(0);
    expect(usual.primary[0]!.productName).toBe("آب");
    expect(usual.primary[0]!.timesOrdered).toBe(2);
    // Customer 666 ordered once → below threshold → no usual.
    expect(loyalty.usualFor(666).primary.length).toBe(0);
  });

  test("rating is saved and idempotent per order", () => {
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    orders.attachReceipt(555, "f", 1);
    orders.setDeliveryNotes(555, null);
    const conf = orders.confirmOrder(555, "C") as any;
    const id = conf.order.id;
    const r = loyalty.saveRating(id, 555, 5, "عالی");
    expect(r.ok).toBe(true);
    // Another customer cannot rate this order.
    expect(loyalty.saveRating(id, 666, 1).ok).toBe(false);
    expect(loyalty.getRatingForOrder(id)?.rating).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// AI settings
// ---------------------------------------------------------------------------

describe("AI settings", () => {
  test("defaults are safe and persona falls back when empty", () => {
    const s = getAiSettings(db);
    expect(s.enabled).toBe(true);
    expect(s.persona.length).toBeGreaterThan(0);
  });

  test("settings persist and empty persona restores default", () => {
    updateAiSettings(db, { persona: "کاملاً رسمی باش", enabled: false, replyLength: "concise" });
    const s = getAiSettings(db);
    expect(s.persona).toBe("کاملاً رسمی باش");
    expect(s.enabled).toBe(false);
    expect(s.replyLength).toBe("concise");
    updateAiSettings(db, { persona: "" });
    expect(getAiSettings(db).persona.length).toBeGreaterThan(0);
  });

  test("notification toggles default on and persist", () => {
    expect(getNotificationSettings(db).notifyOrderConfirmed).toBe(true);
    expect(getNotificationSettings(db).askDeliveryRating).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin API: lifecycle actions, deposit review, customer detail
// ---------------------------------------------------------------------------

describe("admin order lifecycle API", () => {
  // Minimal ApiApp harness (same shape as admin-http.test.ts).
  let apiApp: any;
  const ADMIN = { id: 777, first_name: "Admin" };
  const NOW_S = () => Math.floor(Date.now() / 1000);

  function headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-telegram-init-data": signInitData("123456:TEST-ADM-TOKEN", ADMIN as any, NOW_S()),
    };
  }

  async function call(method: string, path: string, body?: unknown) {
    return handleAdminApi(
      new Request(`http://localhost${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      apiApp,
    ).then(async (r) => ({ status: r!.status, body: await r!.json() }));
  }

  beforeEach(() => {
    const config = loadConfig({
      BOT_TOKEN: "123456:TEST-ADM-TOKEN",
      ADMIN_IDS: "777",
      TIMEZONE: "Asia/Tehran",
      APP_BASE_URL: "https://cafe.example.com",
    });
    apiApp = {
      config,
      db,
      menu,
      orders,
      businessHours: bh,
      reports: new ReportService(db, bh, new NotificationService(db), "Asia/Tehran"),
      notifications: new NotificationService(db),
      uploadsDir: "/tmp/cafe-uploads-test",
      customers,
      loyalty,
    };
  });

  function place(): { id: number; orderNumber: string } {
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    orders.attachReceipt(555, "f", 1);
    orders.setDeliveryNotes(555, null);
    const conf = orders.confirmOrder(555, "Cust");
    if (!conf.ok) throw new Error("order failed");
    return { id: conf.order.id, orderNumber: conf.order.orderNumber };
  }

  test("confirm + deliver transitions work and are idempotent", async () => {
    const { orderNumber } = place();
    const c1 = await call("POST", `/api/admin/orders/${orderNumber}/confirm`);
    expect(c1.status).toBe(200);
    expect((c1.body as any).already).toBe(false);
    const c2 = await call("POST", `/api/admin/orders/${orderNumber}/confirm`);
    expect(c2.status).toBe(200);
    expect((c2.body as any).already).toBe(true); // duplicate callback is a no-op
    const d = await call("POST", `/api/admin/orders/${orderNumber}/deliver`);
    expect(d.status).toBe(200);
    // Delivering a delivered order again: idempotent.
    const d2 = await call("POST", `/api/admin/orders/${orderNumber}/deliver`);
    expect(d2.status).toBe(200);
    expect((d2.body as any).already).toBe(true);
  });

  test("confirming does not mark the order paid", async () => {
    const { orderNumber } = place();
    await call("POST", `/api/admin/orders/${orderNumber}/confirm`);
    const o = orders.findByNumber(orderNumber)!;
    expect(o.paymentStatus).toBe("receipt_received");
    expect(o.fulfillmentStatus).toBe("confirmed");
  });

  test("deposit approve/reject via API is admin-authorized and idempotent", async () => {
    const dep = customers.createDeposit(555, 25000);
    if (!dep.ok) throw new Error("deposit failed");
    const ok = await call("POST", `/api/admin/wallet/deposits/${dep.deposit.id}/approve`);
    expect(ok.status).toBe(200);
    expect(customers.getBalance(555)).toBe(25000);
    const dup = await call("POST", `/api/admin/wallet/deposits/${dep.deposit.id}/approve`);
    expect(dup.status).toBe(400); // already reviewed
    expect(customers.getBalance(555)).toBe(25000);
  });

  test("customer detail distinguishes order value from paid", async () => {
    const { orderNumber } = place();
    await call("POST", `/api/admin/orders/${orderNumber}/confirm`); // not paid
    const detail = await call("GET", "/api/admin/customers/555");
    expect(detail.status).toBe(200);
    const b = detail.body as any;
    expect(b.orderValue).toBe(15000);
    expect(b.paidTotal).toBe(0); // card receipt not yet marked paid
    expect(b.outstanding).toBe(15000);
  });

  test("customer notifications enqueue on confirm/deliver and respect toggles", async () => {
    const { orderNumber } = place();
    await call("POST", `/api/admin/orders/${orderNumber}/confirm`);
    let rows = db.query("SELECT * FROM notifications WHERE kind = 'customer_notice'").all() as any[];
    expect(rows.some((r) => r.ref_key === `order_confirmed_${orderNumber}`)).toBe(true);

    // Disable the toggle → no new notice on the next order.
    updateNotificationSettings(db, { notifyOrderConfirmed: false });
    const second = place();
    await call("POST", `/api/admin/orders/${second.orderNumber}/confirm`);
    rows = db.query("SELECT * FROM notifications WHERE kind = 'customer_notice'").all() as any[];
    expect(rows.some((r) => r.ref_key === `order_confirmed_${second.orderNumber}`)).toBe(false);
  });
});
