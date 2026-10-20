import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import type { Order } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { NotificationService } from "../src/services/notifications";
import { ChannelMembershipService } from "../src/services/membership";
import { ReferralService } from "../src/services/referrals";
import { RefundsService } from "../src/services/refunds";
import { updatePaymentSettings } from "../src/services/settings";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import { loadConfig } from "../src/config";
import { ReportService } from "../src/services/reports";
import type { ApiApp } from "../src/api/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOT_TOKEN = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ";
const MONDAY_OPEN = new Date("2026-10-12T10:00:00+03:30");
const ADMIN = { id: 777, first_name: "Admin" };
const NOW_S = () => Math.floor(Date.now() / 1000);

let db: Db;
let menu: MenuService;
let cart: CartService;
let orders: OrdersService;
let customers: CustomersService;
let refunds: RefundsService;
let waterId: number;
let teaId: number;
let app: ApiApp;

beforeEach(() => {
  setSystemTime(MONDAY_OPEN);
  db = openDatabase(":memory:");
  const config = loadConfig({
    BOT_TOKEN,
    ADMIN_IDS: "777",
    TIMEZONE: "Asia/Tehran",
    APP_BASE_URL: "https://cafe.example.com",
  });
  const businessHours = new BusinessHoursService(db, config.timezone);
  menu = new MenuService(db);
  cart = new CartService(db);
  orders = new OrdersService(db, businessHours);
  customers = new CustomersService(db);
  refunds = new RefundsService(db);
  const notifications = new NotificationService(db);
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  const cat = menu.createCategory({ name: "نوشیدنی" });
  waterId = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 100_000 }).id;
  teaId = menu.createProduct({ categoryId: cat.id, name: "چای", fixedPriceAmount: 50_000 }).id;
  app = {
    config,
    db,
    menu,
    orders,
    businessHours,
    reports: new ReportService(db, businessHours, notifications, config.timezone),
    notifications,
    uploadsDir: mkdtempSync(join(tmpdir(), "cafe-uploads-")),
    customers,
    loyalty: new LoyaltyService(db),
    membership: new ChannelMembershipService(db),
    referrals: new ReferralService(db),
    refunds,
  };
});

afterEach(() => {
  setSystemTime();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fund the wallet so a wallet-paid checkout can succeed. */
function fundWallet(telegramId: number, amount: number): void {
  const c = customers.createDeposit(telegramId, amount);
  if (!c.ok) throw new Error("deposit failed");
  const a = customers.approveDeposit(c.deposit.id, 777);
  if (!a.ok) throw new Error("approve failed");
}

/** Paid wallet order (paid at creation). */
function placeWalletOrder(userId: number, qty: number, productId = waterId): Order {
  fundWallet(userId, 10_000_000);
  cart.addItem(userId, productId, null, qty);
  orders.startCheckout(userId);
  orders.attachReceipt(userId, "f", 1);
  cart.setFulfillmentMethod(userId, "pickup");
  const r = orders.confirmOrder(userId, "مشتری", true);
  if (!r.ok) throw new Error(`wallet order failed: ${JSON.stringify(r)}`);
  return r.order;
}

/** Paid card-to-card order (receipt attached then marked paid). */
function placePaidCardOrder(userId: number, qty: number, productId = waterId): Order {
  cart.addItem(userId, productId, null, qty);
  orders.startCheckout(userId);
  orders.choosePaymentMethod(userId, "card_to_card");
  const r = orders.placeOrderAfterReceipt(userId, "receipt-file", 42, "مشتری");
  if (!r.ok) throw new Error(`card order failed: ${JSON.stringify(r)}`);
  const paid = orders.markPaymentPaid(r.order.id, 777);
  if (!paid.ok) throw new Error("mark paid failed");
  return paid.order;
}

/** Unpaid card order (receipt attached, NOT approved). */
function placeUnpaidCardOrder(userId: number, qty: number): Order {
  cart.addItem(userId, waterId, null, qty);
  orders.startCheckout(userId);
  orders.choosePaymentMethod(userId, "card_to_card");
  const r = orders.placeOrderAfterReceipt(userId, "receipt-file", 42, "مشتری");
  if (!r.ok) throw new Error(`card order failed: ${JSON.stringify(r)}`);
  return r.order;
}

const VALID_CARD = "6037991234567893";
const VALID_CARD_2 = "9919123456789016";

function headersFor(user: { id: number; first_name: string }): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-telegram-init-data": signInitData(BOT_TOKEN, user as any, NOW_S()),
  };
}

async function call(method: string, path: string, opts: { body?: unknown; user?: { id: number; first_name: string } } = {}) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const res = await handleAdminApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: headersFor(opts.user ?? ADMIN),
      body,
    }),
    app,
  );
  return { status: res!.status, body: await res!.json() };
}

// ---------------------------------------------------------------------------
// Refund calculations
// ---------------------------------------------------------------------------

describe("refund calculations", () => {
  test("summarize starts with everything refundable", () => {
    const order = placePaidCardOrder(555, 3);
    const s = refunds.summarize(order);
    expect(s.totalAmount).toBe(300_000);
    expect(s.refundedAmount).toBe(0);
    expect(s.remainingRefundableAmount).toBe(300_000);
    expect(s.items[0].refundableQuantity).toBe(3);
  });

  test("refund one whole item line (wallet)", () => {
    const order = placeWalletOrder(555, 1);
    const before = customers.getBalance(555);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "wallet", idempotencyKey: "k1", createdBy: 777 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalAmount).toBe(100_000);
    expect(customers.getBalance(555)).toBe(before + 100_000);
    const refund = refunds.getRefund(r.refunds[0].id)!;
    expect(refund.status).toBe("completed");
    expect(refund.walletTxId).not.toBeNull();
  });

  test("partial quantity then remaining quantity", () => {
    const order = placePaidCardOrder(555, 3);
    const itemId = order.items[0].id;

    const first = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 1 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: "علی" } },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.totalAmount).toBe(100_000);
    expect(first.refunds[0].status).toBe("pending");

    const second = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 2 }],
      { settlementMethod: "card", idempotencyKey: "k2", createdBy: 777, card: { number: VALID_CARD, cardholderName: "علی" } },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.totalAmount).toBe(200_000);

    const s = refunds.summarize(orders.loadOrder(order.id)!);
    expect(s.remainingRefundableAmount).toBe(0);
    expect(s.items[0].refundableQuantity).toBe(0);
  });

  test("over-refund by quantity and amount is rejected", () => {
    const order = placePaidCardOrder(555, 2);
    const itemId = order.items[0].id;
    const r1 = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 5 }],
      { settlementMethod: "wallet", idempotencyKey: "k1", createdBy: 777 },
    );
    expect(r1.ok).toBe(false);

    // Even a valid quantity cannot push cumulative refunds past the paid total.
    const ok = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 2 }],
      { settlementMethod: "wallet", idempotencyKey: "k2", createdBy: 777 },
    );
    expect(ok.ok).toBe(true);
    const again = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 1 }],
      { settlementMethod: "wallet", idempotencyKey: "k3", createdBy: 777 },
    );
    expect(again.ok).toBe(false);
  });

  test("multiple items in one request", () => {
    cart.addItem(555, waterId, null, 2);
    cart.addItem(555, teaId, null, 1);
    orders.startCheckout(555);
    orders.choosePaymentMethod(555, "card_to_card");
    const placed = orders.placeOrderAfterReceipt(555, "r", 1, "مشتری");
    if (!placed.ok) throw new Error("place failed");
    const paid = orders.markPaymentPaid(placed.order.id, 777);
    if (!paid.ok) throw new Error("mark paid failed");
    const order = paid.order; // reloaded with paymentStatus "paid"
    expect(order.items.length).toBe(2);

    const r = refunds.createItemRefunds(
      order,
      order.items.map((i) => ({ orderItemId: i.id, quantity: 1 })),
      { settlementMethod: "wallet", idempotencyKey: "k1", createdBy: 777 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refunds.length).toBe(2);
    expect(r.totalAmount).toBe(150_000); // 1×100k + 1×50k
  });

  test("full-order refund refunds only the remainder after a partial", () => {
    const order = placePaidCardOrder(555, 3);
    const itemId = order.items[0].id;
    const before = customers.getBalance(555);

    const partial = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 1 }],
      { settlementMethod: "wallet", idempotencyKey: "k1", createdBy: 777 },
    );
    expect(partial.ok).toBe(true);
    expect(customers.getBalance(555)).toBe(before + 100_000);

    const full = refunds.createFullOrderRefund(order, {
      settlementMethod: "wallet",
      idempotencyKey: "k2",
      createdBy: 777,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.totalAmount).toBe(200_000); // only the 2 remaining units
    expect(customers.getBalance(555)).toBe(before + 300_000);

    // A second full refund has nothing left to give.
    const again = refunds.createFullOrderRefund(order, {
      settlementMethod: "wallet",
      idempotencyKey: "k3",
      createdBy: 777,
    });
    expect(again.ok).toBe(false);
  });

  test("rejects refunds for unpaid orders", () => {
    const order = placeUnpaidCardOrder(555, 1);
    expect(order.paymentStatus).not.toBe("paid");
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "wallet", idempotencyKey: "k1", createdBy: 777 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("پرداخت");
  });

  test("cancelled refund frees the amount again", () => {
    const order = placePaidCardOrder(555, 2);
    const itemId = order.items[0].id;
    const pending = refunds.createItemRefunds(
      order,
      [{ orderItemId: itemId, quantity: 2 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: null } },
    );
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(refunds.summarize(order).remainingRefundableAmount).toBe(0);

    const cancelled = refunds.cancelRefund(pending.refunds[0].id, 777, "اشتباه بود");
    expect(cancelled.ok).toBe(true);
    const s = refunds.summarize(orders.loadOrder(order.id)!);
    expect(s.remainingRefundableAmount).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// Wallet refunds
// ---------------------------------------------------------------------------

describe("wallet refunds", () => {
  test("ledger row and refund record stay consistent", () => {
    const order = placeWalletOrder(555, 2);
    const before = customers.getBalance(555);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "wallet", idempotencyKey: "k1", createdBy: 777 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.balanceAfter).toBe(before + 100_000);

    const txs = customers.listTransactions(555, 50);
    const refundTx = txs.find((t) => t.kind === "refund" && t.id === r.refunds[0].walletTxId);
    expect(refundTx).toBeDefined();
    expect(refundTx!.amount).toBe(100_000);
    expect(refundTx!.refId).toBe(r.refunds[0].id);
    expect(refundTx!.createdBy).toBe(777);
  });

  test("replayed idempotency key cannot credit the wallet twice", () => {
    const order = placeWalletOrder(555, 2);
    const before = customers.getBalance(555);
    const input = { settlementMethod: "wallet" as const, idempotencyKey: "same-key", createdBy: 777 };
    const first = refunds.createItemRefunds(order, [{ orderItemId: order.items[0].id, quantity: 1 }], input);
    expect(first.ok).toBe(true);
    const mid = customers.getBalance(555);
    expect(mid).toBe(before + 100_000);

    const replay = refunds.createItemRefunds(order, [{ orderItemId: order.items[0].id, quantity: 1 }], input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.already).toBe(true);
    expect(customers.getBalance(555)).toBe(mid); // unchanged
    const all = refunds.listForOrder(order.id);
    expect(all.filter((x) => x.status !== "cancelled").length).toBe(1);
  });

  test("zero/negative quantity and duplicate lines are rejected", () => {
    const order = placePaidCardOrder(555, 2);
    const itemId = order.items[0].id;
    expect(
      refunds.createItemRefunds(order, [{ orderItemId: itemId, quantity: 0 }], {
        settlementMethod: "wallet", idempotencyKey: "k", createdBy: 777,
      }).ok,
    ).toBe(false);
    expect(
      refunds.createItemRefunds(order, [
        { orderItemId: itemId, quantity: 1 },
        { orderItemId: itemId, quantity: 1 },
      ], {
        settlementMethod: "wallet", idempotencyKey: "k2", createdBy: 777,
      }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Card refunds
// ---------------------------------------------------------------------------

describe("card refunds", () => {
  test("creates a pending refund with a masked destination snapshot", () => {
    customers.saveCard(555, VALID_CARD);
    const order = placePaidCardOrder(555, 1);
    const balanceBefore = customers.getBalance(555);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: "علی" } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const refund = r.refunds[0];
    expect(refund.status).toBe("pending");
    expect(refund.cardLast4).toBe("7893");
    expect(refund.cardMasked).toBe("**** **** **** 7893");
    expect(refund.cardholderName).toBe("علی");
    expect(refund.walletTxId).toBeNull();
    expect(customers.getBalance(555)).toBe(balanceBefore); // wallet untouched
  });

  test("missing card blocks card settlement at the service layer", () => {
    const order = placePaidCardOrder(555, 1);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: null },
    );
    expect(r.ok).toBe(false);
  });

  test("completing records the responsible admin and timestamp; duplicate is idempotent", () => {
    const order = placePaidCardOrder(555, 1);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: null } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.refunds[0].id;

    const done = refunds.completeCardRefund(id, 777);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.already).toBe(false);
    expect(done.refund.status).toBe("completed");
    expect(done.refund.completedBy).toBe(777);
    expect(done.refund.completedAt).not.toBeNull();

    const dup = refunds.completeCardRefund(id, 777);
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.already).toBe(true);
  });

  test("cancelling a completed refund is rejected", () => {
    const order = placePaidCardOrder(555, 1);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: null } },
    );
    if (!r.ok) throw new Error("create failed");
    expect(refunds.completeCardRefund(r.refunds[0].id, 777).ok).toBe(true);
    const cancel = refunds.cancelRefund(r.refunds[0].id, 777, null);
    expect(cancel.ok).toBe(false);
  });

  test("changing the customer's card does not alter an existing refund snapshot", () => {
    customers.saveCard(555, VALID_CARD);
    const order = placePaidCardOrder(555, 1);
    const r = refunds.createItemRefunds(
      order,
      [{ orderItemId: order.items[0].id, quantity: 1 }],
      { settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: null } },
    );
    if (!r.ok) throw new Error("create failed");

    customers.saveCard(555, VALID_CARD_2); // customer replaces their card
    const refund = refunds.getRefund(r.refunds[0].id)!;
    expect(refund.cardLast4).toBe("7893"); // original snapshot intact
    expect(refund.cardMasked).toBe("**** **** **** 7893");
    expect(customers.getCard(555)!.last4).toBe("9016"); // profile card updated
  });

  test("listPendingCard returns only pending card refunds", () => {
    const order = placePaidCardOrder(555, 2);
    const a = refunds.createItemRefunds(order, [{ orderItemId: order.items[0].id, quantity: 1 }], {
      settlementMethod: "card", idempotencyKey: "k1", createdBy: 777, card: { number: VALID_CARD, cardholderName: null },
    });
    const b = refunds.createItemRefunds(order, [{ orderItemId: order.items[0].id, quantity: 1 }], {
      settlementMethod: "wallet", idempotencyKey: "k2", createdBy: 777,
    });
    if (!a.ok || !b.ok) throw new Error("create failed");
    // Wallet refund is completed immediately; the card one is pending.
    const pending = refunds.listPendingCard();
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(a.refunds[0].id);

    expect(refunds.completeCardRefund(a.refunds[0].id, 777).ok).toBe(true);
    expect(refunds.listPendingCard().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// API (admin HTTP)
// ---------------------------------------------------------------------------

describe("refund admin API", () => {
  test("unauthorized requests are rejected", async () => {
    const res = await handleAdminApi(
      new Request("http://localhost/api/admin/refunds/pending"),
      app,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);

    const nonAdmin = await call("GET", "/api/admin/refunds/pending", { user: { id: 999, first_name: "X" } });
    expect(nonAdmin.status).toBe(403);
  });

  test("admin creates a wallet refund via POST and sees it in the order payload", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const order = placeWalletOrder(555, 2);
    const before = customers.getBalance(555);

    const create = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/refunds`, {
      body: {
        items: [{ orderItemId: order.items[0].id, quantity: 1 }],
        settlementMethod: "wallet",
        reasonCode: "quality",
        idempotencyKey: "api-k1",
      },
    });
    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(create.body.totalAmount).toBe(100_000);
    expect(customers.getBalance(555)).toBe(before + 100_000);

    const detail = await call("GET", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.refunds.length).toBe(1);
    expect(detail.body.refundSummary.remainingRefundableAmount).toBe(100_000);
    expect(detail.body.customerCard.hasCard).toBe(false);
    // backward-compatible top-level fields still present
    expect(detail.body.orderNumber).toBe(order.orderNumber);
    expect(detail.body.totalAmount).toBe(200_000);
  });

  test("card refund via API requires a registered card; then completes from the pending list", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    const order = placePaidCardOrder(555, 1);

    const noCard = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/refunds`, {
      body: { items: [{ orderItemId: order.items[0].id, quantity: 1 }], settlementMethod: "card", idempotencyKey: "api-c1" },
    });
    expect(noCard.status).toBe(400);

    customers.saveCard(555, VALID_CARD);
    const balanceBefore = customers.getBalance(555);
    const create = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/refunds`, {
      body: {
        items: [{ orderItemId: order.items[0].id, quantity: 1 }],
        settlementMethod: "card",
        idempotencyKey: "api-c2",
      },
    });
    expect(create.status).toBe(200);
    expect(create.body.refunds[0].status).toBe("pending");
    expect(create.body.refunds[0].cardMasked).toBe("**** **** **** 7893");
    expect(customers.getBalance(555)).toBe(balanceBefore); // never wallet-credited

    const pending = await call("GET", "/api/admin/refunds/pending");
    expect(pending.status).toBe(200);
    expect(pending.body.refunds.length).toBe(1);
    expect(pending.body.refunds[0].orderNumber).toBe(order.orderNumber);
    const refundId = pending.body.refunds[0].id;

    const complete = await call("POST", `/api/admin/refunds/${refundId}/complete`, { body: {} });
    expect(complete.status).toBe(200);
    expect(complete.body.refund.status).toBe("completed");

    const pendingAfter = await call("GET", "/api/admin/refunds/pending");
    expect(pendingAfter.body.refunds.length).toBe(0);
  });

  test("full-order refund through the API", async () => {
    customers.saveProfile(555, { fullName: "مشتری" });
    const order = placePaidCardOrder(555, 2);
    const before = customers.getBalance(555);
    const create = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/refunds`, {
      body: { fullOrder: true, settlementMethod: "wallet", idempotencyKey: "api-full" },
    });
    expect(create.status).toBe(200);
    expect(create.body.totalAmount).toBe(200_000);
    expect(customers.getBalance(555)).toBe(before + 200_000);
  });

  test("cancel endpoint frees the amount", async () => {
    customers.saveProfile(555, { fullName: "مشتری" });
    customers.saveCard(555, VALID_CARD);
    const order = placePaidCardOrder(555, 1);
    const create = await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/refunds`, {
      body: { items: [{ orderItemId: order.items[0].id, quantity: 1 }], settlementMethod: "card", idempotencyKey: "api-x" },
    });
    expect(create.status).toBe(200);
    const refundId = create.body.refunds[0].id;
    const cancel = await call("POST", `/api/admin/refunds/${refundId}/cancel`, { body: { reason: "تست" } });
    expect(cancel.status).toBe(200);
    expect(cancel.body.refund.status).toBe("cancelled");
  });

  test("customer profile endpoint exposes masked card and refund history only", async () => {
    customers.saveProfile(555, { fullName: "علی" });
    customers.saveCard(555, VALID_CARD);
    const order = placePaidCardOrder(555, 1);
    await call("POST", `/api/admin/orders/${encodeURIComponent(order.orderNumber)}/refunds`, {
      body: { items: [{ orderItemId: order.items[0].id, quantity: 1 }], settlementMethod: "card", idempotencyKey: "api-p" },
    });
    const detail = await call("GET", "/api/admin/customers/555");
    expect(detail.status).toBe(200);
    expect(detail.body.card.hasCard).toBe(true);
    expect(detail.body.card.masked).toBe("**** **** **** 7893");
    expect(detail.body.card.cardNumber).toBeUndefined(); // full number never exposed
    expect(detail.body.refunds.length).toBe(1);
    expect(detail.body.refunds[0].cardMasked).toBe("**** **** **** 7893");
  });
});
