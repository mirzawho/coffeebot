import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { ReportService, buildDailyReportText, buildOrderUpdateText } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";
import { updateReportSettings, updatePaymentSettings, getReportSettings } from "../src/services/settings";

let db: Db;
let menu: MenuService;
let cart: CartService;
let orders: OrdersService;
let bh: BusinessHoursService;
let notif: NotificationService;
let reports: ReportService;
const ADMIN_IDS = new Set([111, 222]);

beforeEach(() => {
  db = openDatabase(":memory:");
  menu = new MenuService(db);
  bh = new BusinessHoursService(db, "Asia/Tehran");
  cart = new CartService(db);
  orders = new OrdersService(db, bh);
  notif = new NotificationService(db);
  reports = new ReportService(db, bh, notif, "Asia/Tehran");
  updateReportSettings(
    db,
    { enabled: true, time: "18:30", sendEmpty: false, recipients: [111, 222] },
    ADMIN_IDS,
  );
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  const cat = menu.createCategory({ name: "نوشیدنی" });
  menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 });
});

function placeOrder(userId: number, name = "Customer") {
  const product = menu.listProducts(undefined, false)[0]!;
  cart.addItem(userId, product.id, null, 1);
  orders.startCheckout(userId);
  orders.attachReceipt(userId, `file-${userId}`, userId);
  orders.setDeliveryNotes(userId, null);
  const conf = orders.confirmOrder(userId, name);
  if (!conf.ok) throw new Error("order failed: " + JSON.stringify(conf));
  return conf.order;
}

describe("report settings validation", () => {
  test("fresh database defaults to 07:30 delivery time", () => {
    // Regression for the redesigned settings page: an operator who never
    // opened report settings must get the documented 07:30 default.
    const fresh = openDatabase(":memory:");
    expect(getReportSettings(fresh).time).toBe("07:30");
  });

  test("recipients must be in ADMIN_IDS", () => {
    expect(() =>
      updateReportSettings(db, { enabled: true, time: "18:30", sendEmpty: false, recipients: [999] }, ADMIN_IDS),
    ).toThrow();
  });

  test("invalid time rejected", () => {
    expect(() =>
      updateReportSettings(db, { enabled: true, time: "25:00", sendEmpty: false, recipients: [111] }, ADMIN_IDS),
    ).toThrow();
  });
});

describe("trySend", () => {
  test("enqueues per-recipient notifications idempotently", () => {
    const order = placeOrder(1);
    const out = reports.trySend(order.businessDate);
    expect(out.action).toBe("enqueued");
    const rows = db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'daily_report'")
      .get() as { c: number };
    expect(rows.c).toBe(2);

    // Second call: run already claimed -> no duplicates.
    const again = reports.trySend(order.businessDate);
    expect(again.action).toBe("already_claimed");
    const rows2 = db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'daily_report'")
      .get() as { c: number };
    expect(rows2.c).toBe(2);
  });

  test("skips empty day when sendEmpty is false", () => {
    const bd = bh.reportBusinessDate(new Date());
    const out = reports.trySend(bd);
    expect(out.action).toBe("skipped_empty");
    const run = db.query("SELECT status FROM report_runs WHERE business_date = ?").get(bd) as any;
    expect(run.status).toBe("skipped_empty");
  });

  test("sends empty day when sendEmpty is true", () => {
    updateReportSettings(db, { enabled: true, time: "18:30", sendEmpty: true, recipients: [111] }, ADMIN_IDS);
    const bd = bh.reportBusinessDate(new Date());
    const out = reports.trySend(bd);
    expect(out.action).toBe("enqueued");
    if (out.action === "enqueued") expect(out.orderCount).toBe(0);
  });

  test("disabled reports do nothing", () => {
    updateReportSettings(db, { enabled: false, time: "18:30", sendEmpty: false, recipients: [111] }, ADMIN_IDS);
    const out = reports.trySend(bh.reportBusinessDate(new Date()));
    expect(out.action).toBe("disabled");
  });

  test("no recipients -> no_recipients", () => {
    updateReportSettings(db, { enabled: true, time: "18:30", sendEmpty: true, recipients: [] }, ADMIN_IDS);
    const out = reports.trySend(bh.reportBusinessDate(new Date()));
    expect(out.action).toBe("no_recipients");
  });
});

describe("late orders", () => {
  test("order after report generates immediate order_update notifications", () => {
    const o1 = placeOrder(1);
    reports.trySend(o1.businessDate);
    // Simulate delivery confirmation so run is complete.
    for (const n of notif.claimDue(new Date())) notif.markSent(n.id);

    const o2 = placeOrder(2, "Sara");
    expect(o2.businessDate).toBe(o1.businessDate);
    const rows = db
      .query("SELECT kind, ref_key FROM notifications WHERE kind = 'order_update' ORDER BY id")
      .all() as any[];
    expect(rows.length).toBe(2); // two recipients
    expect(rows[0].ref_key).toBe(o2.orderNumber);
  });

  test("order AFTER skipped_empty report also generates order_update notifications", () => {
    // Scenario: report time < closing. At report time the day is empty ->
    // skipped_empty. An order later the same business day must still notify.
    // Deterministic across wall-clock: pin bd to the date a *new order* would
    // receive right now (targetBusinessDate), which is what confirmOrder uses.
    const bd = bh.targetBusinessDate(new Date());
    const out = reports.trySend(bd);
    expect(out.action).toBe("skipped_empty");

    const o = placeOrder(1);
    expect(o.businessDate).toBe(bd);
    const rows = db
      .query("SELECT kind, ref_key FROM notifications WHERE kind = 'order_update'")
      .all() as any[];
    expect(rows.length).toBe(2); // two recipients from settings
    expect(rows[0].ref_key).toBe(o.orderNumber);
  });

  test("order BEFORE report does not generate order_update (it is in the report)", () => {
    const o1 = placeOrder(1);
    reports.trySend(o1.businessDate);
    const rows = db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'order_update'")
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("report text", () => {
  test("contains order details and unverified-payment notice", () => {
    const o = placeOrder(1, "Ali");
    const text = buildDailyReportText([o], o.businessDate);
    const joined = text.chunks.join("\n");
    expect(joined).toContain(o.orderNumber);
    expect(joined).toContain("آب");
    expect(joined).toContain("تأیید");
    expect(text.orderCount).toBe(1);
  });

  test("empty report has explicit empty message", () => {
    const text = buildDailyReportText([], "2026-10-12");
    expect(text.chunks[0]).toContain("ثبت نشده");
  });

  test("chunks stay under Telegram limit", () => {
    const ordersList = Array.from({ length: 80 }, (_, i) => ({
      ...placeOrder(1000 + i),
    }));
    // placeOrder reuses cart per user; each user unique so fine.
    const text = buildDailyReportText(ordersList, ordersList[0]!.businessDate);
    for (const c of text.chunks) expect(c.length).toBeLessThanOrEqual(4000);
  });

  test("order update text includes receipt flag", () => {
    const o = placeOrder(1);
    const { text, receiptFileId } = buildOrderUpdateText(o);
    expect(text).toContain(o.orderNumber);
    expect(receiptFileId).toBe("file-1");
    expect(text).toContain("تأیید");
  });
});

describe("dueBusinessDate gating", () => {
  test("null before report time, set after", () => {
    placeOrder(1);
    // Report time is 18:30 Tehran.
    expect(reports.dueBusinessDate(new Date("2026-10-13T10:00:00+03:30"))).toBeNull();
    expect(reports.dueBusinessDate(new Date("2026-10-13T19:00:00+03:30"))).toBe("2026-10-13");
    expect(reports.dueBusinessDate(new Date("2026-10-13T18:30:00+03:30"))).toBe("2026-10-13");
  });
});

describe("notification idempotency", () => {
  test("duplicate enqueue with same ref+recipient is ignored", () => {
    notif.enqueue("daily_report", "2026-10-12", [111], { type: "daily_report", businessDate: "2026-10-12" });
    notif.enqueue("daily_report", "2026-10-12", [111], { type: "daily_report", businessDate: "2026-10-12" });
    const rows = db
      .query("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'daily_report'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("claimDue is atomic — second claim gets nothing", () => {
    notif.enqueue("order_update", "CN-1", [111], { type: "order_update", orderId: 1 });
    const first = notif.claimDue(new Date());
    expect(first.length).toBe(1);
    const second = notif.claimDue(new Date());
    expect(second.length).toBe(0);
  });
});
