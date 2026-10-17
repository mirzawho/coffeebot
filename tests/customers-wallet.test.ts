import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { CustomersService, normalizePhone } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { updatePaymentSettings, getPaymentSettings, cardToCardAvailable, getAiSettings, updateAiSettings, getNotificationSettings, updateNotificationSettings } from "../src/services/settings";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import { loadConfig } from "../src/config";
import { ReportService } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";
import { Scheduler } from "../src/scheduler";

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
    const r = customers.saveProfile(555, { fullName: "علی رضایی", phone: "09121234567" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.telegramId).toBe(555);
    expect(r.profile.fullName).toBe("علی رضایی");
    expect(customers.getProfile(666)).toBeNull(); // isolated per user
  });

  test("updates an existing profile", () => {
    customers.saveProfile(555, { fullName: "علی رضایی" });
    const r = customers.saveProfile(555, { fullName: "علی رضایی", phone: "09121234567" });
    expect(r.ok).toBe(true);
    expect(customers.getProfile(555)?.phone).toBe("09121234567");
  });

  test("rejects empty name and invalid phone", () => {
    expect(customers.saveProfile(555, { fullName: "" }).ok).toBe(false);
    const r = customers.saveProfile(555, { fullName: "x", phone: "123" });
    expect(r.ok).toBe(false);
  });

  test("normalizes Persian digits and international formats", () => {
    expect(normalizePhone("۰۹۱۲۱۲۳۴۵۶۷")).toBe("09121234567");
    expect(normalizePhone("+989121234567")).toBe("09121234567");
    expect(normalizePhone("9121234567")).toBe("09121234567");
    expect(normalizePhone("garbage")).toBeNull();
  });

  test("saves and clears an optional address", () => {
    customers.saveProfile(555, { fullName: "علی رضایی", phone: "09121234567", address: "تهران، خیابان ولیعصر" });
    expect(customers.getProfile(555)?.address).toBe("تهران، خیابان ولیعصر");
    // Omitting address keeps it; explicit null clears it.
    customers.saveProfile(555, { fullName: "علی رضایی" });
    expect(customers.getProfile(555)?.address).toBe("تهران، خیابان ولیعصر");
    customers.saveProfile(555, { fullName: "علی رضایی", address: null });
    expect(customers.getProfile(555)?.address).toBeNull();
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
    cart.setFulfillmentMethod(userId, "pickup");
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
    cart.setFulfillmentMethod(555, "pickup");
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
    cart.setFulfillmentMethod(555, "pickup");
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
    cart.setFulfillmentMethod(userId, "pickup");
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
    cart.setFulfillmentMethod(555, "pickup");
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
    expect(getNotificationSettings(db).notifyWalletChanges).toBe(true);
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
    cart.setFulfillmentMethod(555, "pickup");
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

  test("customer list merges profiles, wallets, and order-only customers", async () => {
    // 555: profile + order; 666: order without any saved profile.
    customers.saveProfile(555, { fullName: "علی رضایی", phone: "09121234567" });
    place();
    cart.addItem(666, waterId, null, 1);
    orders.startCheckout(666);
    orders.attachReceipt(666, "f-666", 1);
    cart.setFulfillmentMethod(666, "pickup");
    const conf2 = orders.confirmOrder(666, "Customer2");
    expect(conf2.ok).toBe(true);

    const r = await call("GET", "/api/admin/customers");
    expect(r.status).toBe(200);
    const byId = new Map((r.body as any[]).map((c: any) => [c.id, c]));
    expect(byId.size).toBe(2);
    expect(byId.get(555)!.name).toBe("علی رضایی");
    expect(byId.get(555)!.phone).toBe("09121234567");
    expect(byId.get(555)!.orderCount).toBe(1);
    expect(byId.get(555)!.orderValue).toBe(15000);
    // Order-only customer appears with a null name for the UI to fall back on.
    expect(byId.get(666)!.name).toBeNull();
    expect(byId.get(666)!.orderCount).toBe(1);

    // Server-side search by name and by phone.
    const byName = await call("GET", "/api/admin/customers?q=رضایی");
    expect(byName.body.map((c: any) => c.id)).toEqual([555]);
    const byPhone = await call("GET", "/api/admin/customers?q=09121234567");
    expect(byPhone.body.map((c: any) => c.id)).toEqual([555]);
    const none = await call("GET", "/api/admin/customers?q=ندارد");
    expect(none.body).toEqual([]);
  });

  test("customer list shows wallet balance without raw internals in labels", async () => {
    const dep = customers.createDeposit(555, 40000);
    if (!dep.ok) throw new Error("deposit failed");
    await call("POST", `/api/admin/wallet/deposits/${dep.deposit.id}/approve`);
    customers.saveProfile(555, { fullName: "علی" });

    const r = await call("GET", "/api/admin/customers");
    const row = r.body.find((c: any) => c.id === 555);
    expect(row.balance).toBe(40000);
    // The list payload carries no service-internal fields.
    expect(row.telegramId).toBeUndefined();
    expect(row.id).toBe(555);
  });

  test("customer detail labels wallet transactions and order statuses in Persian", async () => {
    const dep = customers.createDeposit(555, 40000);
    if (!dep.ok) throw new Error("deposit failed");
    await call("POST", `/api/admin/wallet/deposits/${dep.deposit.id}/approve`);
    // Pay an order from the wallet so the ledger records a debit.
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    orders.attachReceipt(555, "f", 1);
    cart.setFulfillmentMethod(555, "pickup");
    const conf = orders.confirmOrder(555, "Cust", true);
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;
    await call("POST", `/api/admin/orders/${conf.order.orderNumber}/confirm`);

    const detail = await call("GET", "/api/admin/customers/555");
    const b = detail.body as any;
    const txKinds = b.transactions.map((t: any) => t.kindLabel);
    expect(txKinds).toContain("واریز به کیف پول");
    expect(txKinds).toContain("پرداخت سفارش");
    for (const t of b.transactions) {
      expect(t.kind).toBeUndefined(); // raw enum never leaves the API
      expect(t.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }
    const o = b.orders[0];
    expect(o.fulfillmentLabel).toBe("تأیید شده");
    expect(o.paymentMethodLabel).toBe("کیف پول");
    expect(o.paymentLabel).toBeTruthy();
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

  test("admin can credit and debit a customer wallet via the API", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const credit = await call("POST", "/api/admin/customers/555/wallet", {
      amount: 50000,
      note: "تخفیف همکاری",
    });
    expect(credit.status).toBe(200);
    expect(credit.body.balance).toBe(50000);

    const debit = await call("POST", "/api/admin/customers/555/wallet", { amount: -20000 });
    expect(debit.status).toBe(200);
    expect(debit.body.balance).toBe(30000);

    // Ledger records both, with Persian kind labels and the admin actor.
    const detail = await call("GET", "/api/admin/customers/555");
    const kinds = detail.body.transactions.map((t: any) => t.kindLabel);
    expect(kinds).toContain("تنظیم موجودی");
    expect(detail.body.balance).toBe(30000);
    // Rows are append-only: two distinct adjustments, both present.
    const adjustments = detail.body.transactions.filter((t: any) => t.kindLabel === "تنظیم موجودی");
    expect(adjustments.length).toBe(2);
  });

  test("a wallet adjustment queues exactly one notice for the customer", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const r = await call("POST", "/api/admin/customers/555/wallet", {
      amount: 50000,
      note: "تخفیف همکاری",
    });
    expect(r.status).toBe(200);
    expect((r.body as any).notified).toBe(true);

    const rows = db
      .query("SELECT * FROM notifications WHERE kind = 'wallet_adjustment'")
      .all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].recipient_id).toBe(555);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.text).toContain("افزایش");
    expect(payload.text).toContain("50,000");
    expect(payload.text).toContain("تخفیف همکاری");
    // The ref key is the ledger transaction id, so it is unique per change.
    expect(rows[0].ref_key).toMatch(/^wallet_tx_\d+$/);
  });

  test("a debit notice reports the reduction and the new balance", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    await call("POST", "/api/admin/customers/555/wallet", { amount: 50000 });
    await call("POST", "/api/admin/customers/555/wallet", { amount: -20000, note: "اصلاح" });

    const rows = db
      .query("SELECT * FROM notifications WHERE kind = 'wallet_adjustment' ORDER BY id")
      .all() as any[];
    expect(rows.length).toBe(2);
    const second = JSON.parse(rows[1].payload);
    expect(second.text).toContain("کاهش");
    expect(second.text).toContain("20,000");
    expect(second.text).toContain("30,000"); // balance after
    expect(second.text).toContain("اصلاح");
  });

  test("a rejected adjustment queues no notice", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const r = await call("POST", "/api/admin/customers/555/wallet", { amount: -99999 });
    expect(r.status).toBe(400); // balance would go negative
    const rows = db
      .query("SELECT * FROM notifications WHERE kind = 'wallet_adjustment'")
      .all() as any[];
    expect(rows.length).toBe(0);
  });

  test("approving a card-to-card top-up queues a wallet notice for the customer", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const dep = customers.createDeposit(555, 75000);
    if (!dep.ok) throw new Error("deposit failed");
    const r = await call("POST", `/api/admin/wallet/deposits/${dep.deposit.id}/approve`);
    expect(r.status).toBe(200);
    expect((r.body as any).balance).toBe(75000);
    expect((r.body as any).notified).toBe(true);

    const rows = db
      .query("SELECT * FROM notifications WHERE kind = 'wallet_adjustment'")
      .all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].recipient_id).toBe(555);
    expect(rows[0].ref_key).toMatch(/^wallet_tx_\d+$/);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.text).toContain("شارژ");
    expect(payload.text).toContain("75,000");
  });

  test("the wallet-notification toggle gates both top-up and adjustment notices", async () => {
    customers.saveProfile(555, { fullName: "علی" });

    // Switch off via the API — no notices from here on.
    const off = await call("PUT", "/api/admin/notification-settings", { notifyWalletChanges: false });
    expect(off.status).toBe(200);
    expect((off.body as any).notifyWalletChanges).toBe(false);

    const dep = customers.createDeposit(555, 30000);
    if (!dep.ok) throw new Error("deposit failed");
    const approve = await call("POST", `/api/admin/wallet/deposits/${dep.deposit.id}/approve`);
    expect(approve.status).toBe(200);
    expect((approve.body as any).balance).toBe(30000); // wallet still credited
    expect((approve.body as any).notified).toBe(false);

    const adjust = await call("POST", "/api/admin/customers/555/wallet", { amount: 10000 });
    expect(adjust.status).toBe(200);
    expect((adjust.body as any).notified).toBe(false);

    const rows = db
      .query("SELECT * FROM notifications WHERE kind = 'wallet_adjustment'")
      .all() as any[];
    expect(rows.length).toBe(0);

    // Switch back on → the next approval notifies again.
    await call("PUT", "/api/admin/notification-settings", { notifyWalletChanges: true });
    const dep2 = customers.createDeposit(555, 20000);
    if (!dep2.ok) throw new Error("deposit failed");
    const approve2 = await call("POST", `/api/admin/wallet/deposits/${dep2.deposit.id}/approve`);
    expect((approve2.body as any).notified).toBe(true);
    const after = db
      .query("SELECT * FROM notifications WHERE kind = 'wallet_adjustment'")
      .all() as any[];
    expect(after.length).toBe(1);
  });

  test("the wallet notice is delivered to the customer by the scheduler", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    await call("POST", "/api/admin/customers/555/wallet", { amount: 50000, note: "هدیه" });

    const sent: { chatId: number; text: string }[] = [];
    const scheduler = new Scheduler({
      db,
      bot: {
        api: {
          sendMessage: async (chatId: number, text: string) => {
            sent.push({ chatId, text });
          },
        },
      } as any,
      reports: apiApp.reports,
      notifications: apiApp.notifications,
      businessHours: bh,
      orders,
    });
    await scheduler.tick();

    expect(sent.length).toBe(1);
    expect(sent[0]!.chatId).toBe(555);
    expect(sent[0]!.text).toContain("50,000");
    expect(sent[0]!.text).toContain("هدیه");
    // Delivered exactly once.
    const row = db.query("SELECT status FROM notifications WHERE kind = 'wallet_adjustment'").get() as any;
    expect(row.status).toBe("sent");
  });

  test("wallet adjustment rejects invalid amounts and unknown customers", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const zero = await call("POST", "/api/admin/customers/555/wallet", { amount: 0 });
    expect(zero.status).toBe(400);
    const overdraw = await call("POST", "/api/admin/customers/555/wallet", { amount: -99999 });
    expect(overdraw.status).toBe(400); // balance would go negative
    const unknown = await call("POST", "/api/admin/customers/424242/wallet", { amount: 1000 });
    expect(unknown.status).toBe(400);
  });

  test("recordSender stores the Telegram username on the profile", () => {
    customers.recordSender(555, { firstName: "علی", lastName: "رضایی", username: "ali_dev" });
    const p = customers.getProfile(555);
    expect(p!.fullName).toBe("علی رضایی");
    expect(p!.username).toBe("ali_dev");
    // A later order-only identity upsert must not clobber the saved phone.
    customers.saveProfile(555, { fullName: "علی رضایی", phone: "09121234567" });
    customers.recordSender(555, { firstName: "علی", username: "ali_dev" });
    expect(customers.getProfile(555)!.phone).toBe("09121234567");
  });

  test("customer list and detail expose username for the chat link", async () => {
    customers.recordSender(555, { firstName: "علی", lastName: "رضایی", username: "ali_dev" });
    const list = await call("GET", "/api/admin/customers");
    const row = list.body.find((c: any) => c.id === 555);
    expect(row.username).toBe("ali_dev");
    // Search by username works.
    const byU = await call("GET", "/api/admin/customers?q=ali_dev");
    expect(byU.body.map((c: any) => c.id)).toContain(555);
    const detail = await call("GET", "/api/admin/customers/555");
    expect(detail.body.profile.username).toBe("ali_dev");
  });
});

// ---------------------------------------------------------------------------
// Admin payment review (card-to-card receipts)
// ---------------------------------------------------------------------------

describe("admin payment review API", () => {
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

  /** Place a card-to-card order with a receipt, exactly like the bot does. */
  function placeCardOrder(): { orderNumber: string } {
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    orders.choosePaymentMethod(555, "card_to_card");
    orders.attachReceipt(555, "receipt-file", 1);
    cart.setFulfillmentMethod(555, "pickup");
    const conf = orders.confirmOrder(555, "Cust");
    if (!conf.ok) throw new Error("order failed");
    return { orderNumber: conf.order.orderNumber };
  }

  test("approving a receipt marks the order paid and is idempotent", async () => {
    const { orderNumber } = placeCardOrder();
    const r = await call("POST", `/api/admin/orders/${orderNumber}/payment/approve`);
    expect(r.status).toBe(200);
    expect((r.body as any).already).toBe(false);
    expect((r.body as any).order.paymentStatus).toBe("paid");
    expect((r.body as any).order.paymentLabel).toBe("پرداخت شده");

    const again = await call("POST", `/api/admin/orders/${orderNumber}/payment/approve`);
    expect(again.status).toBe(200);
    expect((again.body as any).already).toBe(true);

    const o = orders.findByNumber(orderNumber)!;
    expect(o.paymentStatus).toBe("paid");
    expect(o.paymentReviewedBy).toBe(777);
    expect(o.paymentReviewedAt).not.toBeNull();
  });

  test("rejecting a receipt records the decision without marking it paid", async () => {
    const { orderNumber } = placeCardOrder();
    const r = await call("POST", `/api/admin/orders/${orderNumber}/payment/reject`);
    expect(r.status).toBe(200);
    expect((r.body as any).order.paymentStatus).toBe("rejected");
    expect((r.body as any).order.paymentLabel).toBe("رسید رد شده");
    // A rejected payment can still be approved later (admin re-checked it).
    const approve = await call("POST", `/api/admin/orders/${orderNumber}/payment/approve`);
    expect(approve.status).toBe(200);
    expect((approve.body as any).order.paymentStatus).toBe("paid");
  });

  test("a paid order cannot be rejected", async () => {
    const { orderNumber } = placeCardOrder();
    await call("POST", `/api/admin/orders/${orderNumber}/payment/approve`);
    const r = await call("POST", `/api/admin/orders/${orderNumber}/payment/reject`);
    expect(r.status).toBe(400);
    expect(orders.findByNumber(orderNumber)!.paymentStatus).toBe("paid");
  });

  test("a wallet order has no receipt to review", async () => {
    const dep = customers.createDeposit(555, 50000);
    if (!dep.ok) throw new Error("deposit failed");
    customers.approveDeposit(dep.deposit.id, 777);
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    orders.choosePaymentMethod(555, "wallet");
    cart.setFulfillmentMethod(555, "pickup");
    const conf = orders.confirmOrder(555, "Cust");
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;

    // Already paid at creation: approving is a no-op, never a second charge.
    const r = await call("POST", `/api/admin/orders/${conf.order.orderNumber}/payment/approve`);
    expect(r.status).toBe(200);
    expect((r.body as any).already).toBe(true);
    expect(customers.getBalance(555)).toBe(50000 - 15000);
    // And there is no receipt to fetch.
    const receipt = await call("GET", `/api/admin/orders/${conf.order.orderNumber}/receipt`);
    expect(receipt.status).toBe(404);
  });

  test("the receipt endpoint returns the file id, never a bot token", async () => {
    const { orderNumber } = placeCardOrder();
    const r = await call("GET", `/api/admin/orders/${orderNumber}/receipt`);
    expect(r.status).toBe(200);
    expect((r.body as any).fileId).toBe("receipt-file");
    expect(JSON.stringify(r.body)).not.toContain("TEST-ADM-TOKEN");
  });

  test("the receipt image is proxied server-side (the bot token never reaches the browser)", async () => {
    const { orderNumber } = placeCardOrder();
    const requested: string[] = [];
    apiApp.bot = {
      api: {
        getFile: async (fileId: string) => {
          expect(fileId).toBe("receipt-file");
          return { file_path: "photos/receipt.jpg" };
        },
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      requested.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;
    try {
      const res = await handleAdminApi(
        new Request(`http://localhost/api/admin/orders/${orderNumber}/receipt/image`, {
          headers: headers(),
        }),
        apiApp,
      );
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toBe("image/jpeg");
      // The upstream URL carries the token; the response body/headers must not.
      expect(requested[0]).toContain("TEST-ADM-TOKEN");
      const headerDump: string[] = [];
      res!.headers.forEach((v, k) => headerDump.push(`${k}: ${v}`));
      expect(headerDump.join("\n")).not.toContain("TEST-ADM-TOKEN");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failing receipt image fetch degrades to a 502, never a crash", async () => {
    const { orderNumber } = placeCardOrder();
    apiApp.bot = { api: { getFile: async () => ({ file_path: "photos/receipt.jpg" }) } };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    try {
      const res = await handleAdminApi(
        new Request(`http://localhost/api/admin/orders/${orderNumber}/receipt/image`, {
          headers: headers(),
        }),
        apiApp,
      );
      expect(res!.status).toBe(502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the receipt image route is unavailable without a bot (no crash)", async () => {
    const { orderNumber } = placeCardOrder();
    const res = await handleAdminApi(
      new Request(`http://localhost/api/admin/orders/${orderNumber}/receipt/image`, {
        headers: headers(),
      }),
      apiApp,
    );
    expect(res!.status).toBe(503);
  });

  test("payment approval notifies the customer exactly once", async () => {
    const { orderNumber } = placeCardOrder();
    await call("POST", `/api/admin/orders/${orderNumber}/payment/approve`);
    const rows = db
      .query("SELECT * FROM notifications WHERE kind = 'customer_notice'")
      .all() as any[];
    expect(rows.filter((r) => r.ref_key === `payment_approved_${orderNumber}`).length).toBe(1);
    // A repeated approval must not enqueue a second notice.
    await call("POST", `/api/admin/orders/${orderNumber}/payment/approve`);
    const after = db
      .query("SELECT * FROM notifications WHERE kind = 'customer_notice'")
      .all() as any[];
    expect(after.filter((r) => r.ref_key === `payment_approved_${orderNumber}`).length).toBe(1);
  });

  test("order DTO exposes the payment method and status for the panel", async () => {
    const { orderNumber } = placeCardOrder();
    const list = await call("GET", "/api/admin/orders");
    const o = (list.body as any[]).find((x) => x.orderNumber === orderNumber);
    expect(o.paymentMethod).toBe("card_to_card");
    expect(o.paymentMethodLabel).toBe("کارت به کارت");
    expect(o.paymentStatus).toBe("receipt_received");
    expect(o.hasReceipt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Payment method switches (admin)
// ---------------------------------------------------------------------------

describe("payment method switches", () => {
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

  test("both methods default to enabled", () => {
    const p = getPaymentSettings(db);
    expect(p.cardToCardEnabled).toBe(true);
    expect(p.walletEnabled).toBe(true);
  });

  test("switches persist and are returned by the API", async () => {
    const r = await call("PUT", "/api/admin/settings/payment", {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
      walletEnabled: true,
    });
    expect(r.status).toBe(200);
    expect((r.body as any).cardToCardEnabled).toBe(false);
    expect((r.body as any).walletEnabled).toBe(true);
    expect(getPaymentSettings(db).cardToCardEnabled).toBe(false);
  });

  test("refuses to disable both methods at once", async () => {
    const r = await call("PUT", "/api/admin/settings/payment", {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
      walletEnabled: false,
    });
    expect(r.status).toBe(400);
    // Nothing was written — the cafe can still take money.
    expect(getPaymentSettings(db).cardToCardEnabled).toBe(true);
    expect(getPaymentSettings(db).walletEnabled).toBe(true);
  });

  test("refuses to enable card-to-card without a card number", async () => {
    const r = await call("PUT", "/api/admin/settings/payment", {
      cardNumber: "",
      cardholderName: "",
      currency: "تومان",
      cardToCardEnabled: true,
    });
    expect(r.status).toBe(400);
    expect(getPaymentSettings(db).cardNumber).toBe("603799"); // unchanged
  });

  test("a partial update leaves the other switch untouched", async () => {
    await call("PUT", "/api/admin/settings/payment", {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      walletEnabled: false,
    });
    const p = getPaymentSettings(db);
    expect(p.walletEnabled).toBe(false);
    expect(p.cardToCardEnabled).toBe(true);
  });

  test("checkout refuses a wallet order once the switch is off", () => {
    const dep = customers.createDeposit(555, 50000);
    if (!dep.ok) throw new Error("deposit failed");
    customers.approveDeposit(dep.deposit.id, 777);
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      walletEnabled: false,
    });
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    const pick = orders.choosePaymentMethod(555, "wallet");
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.error).toContain("غیرفعال");
    // The balance is untouched and the customer can still pay by card.
    expect(customers.getBalance(555)).toBe(50000);
    expect(orders.choosePaymentMethod(555, "card_to_card").ok).toBe(true);
  });

  test("a wallet order already at the confirm stage is refused after the switch flips", () => {
    const dep = customers.createDeposit(555, 50000);
    if (!dep.ok) throw new Error("deposit failed");
    customers.approveDeposit(dep.deposit.id, 777);
    cart.addItem(555, waterId, null, 1);
    orders.startCheckout(555);
    expect(orders.choosePaymentMethod(555, "wallet").ok).toBe(true);
    // Admin disables wallet payment while the customer is confirming.
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      walletEnabled: false,
    });
    const conf = orders.confirmOrder(555, "Cust");
    expect(conf.ok).toBe(false);
    expect(customers.getBalance(555)).toBe(50000); // never charged
    expect(orders.listForCustomer(555).length).toBe(0);
  });

  test("checkout refuses card-to-card once the switch is off", () => {
    // A funded wallet keeps checkout reachable so the card choice is the thing
    // under test, not the "nothing can pay" guard.
    const dep = customers.createDeposit(555, 50000);
    if (!dep.ok) throw new Error("deposit failed");
    customers.approveDeposit(dep.deposit.id, 777);
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
    });
    cart.addItem(555, waterId, null, 1);
    const co = orders.startCheckout(555);
    expect(co.ok).toBe(true);
    const pick = orders.choosePaymentMethod(555, "card_to_card");
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.error).toContain("غیرفعال");
    // Wallet payment is still available.
    expect(orders.choosePaymentMethod(555, "wallet").ok).toBe(true);
  });

  test("deposits are refused while card-to-card is off (top-ups are paid by card)", () => {
    updatePaymentSettings(db, {
      cardNumber: "603799",
      cardholderName: "Ali",
      currency: "تومان",
      cardToCardEnabled: false,
    });
    // The service still records the request; the bot refuses to start the flow.
    // What matters here is that the availability helper reports it unusable.
    expect(cardToCardAvailable(getPaymentSettings(db))).toBe(false);
  });
});
