import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { ReportService } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";
import { updateReportSettings, updatePaymentSettings } from "../src/services/settings";
import { Scheduler } from "../src/scheduler";

const ADMIN_IDS = new Set([111, 222]);

let db: Db;
let menu: MenuService;
let cart: CartService;
let orders: OrdersService;
let bh: BusinessHoursService;
let notif: NotificationService;
let reports: ReportService;

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
    { enabled: true, time: "18:30", sendEmpty: true, recipients: [111, 222] },
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
  cart.setFulfillmentMethod(userId, "pickup");
  const conf = orders.confirmOrder(userId, name);
  if (!conf.ok) throw new Error("order failed");
  return conf.order;
}

describe("report failure outcome (regression: failure must not look like a duplicate claim)", () => {
  test("a genuine enqueue failure returns 'failed', not 'already_claimed'", () => {
    const bd = bh.reportBusinessDate(new Date());
    // Force the enqueue step to throw by injecting a broken notification service.
    const broken = {
      enqueue: () => {
        throw new Error("disk full");
      },
    } as unknown as NotificationService;
    const failing = new ReportService(db, bh, broken, "Asia/Tehran");

    const out = failing.trySend(bd);
    expect(out.action).toBe("failed");
    if (out.action === "failed") {
      expect(out.businessDate).toBe(bd);
      expect(out.error).toContain("disk full");
    }

    // The run is left 'failed' so a later tick can retry it.
    const run = db
      .query("SELECT status, error FROM report_runs WHERE business_date = ?")
      .get(bd) as { status: string; error: string };
    expect(run.status).toBe("failed");
    expect(run.error).toContain("disk full");
  });

  test("a real duplicate claim still returns 'already_claimed'", () => {
    const bd = bh.reportBusinessDate(new Date());
    const first = reports.trySend(bd);
    expect(first.action).toBe("enqueued");
    const second = reports.trySend(bd);
    expect(second.action).toBe("already_claimed");
  });
});

describe("scheduler report delivery", () => {
  test("delivers a daily report to every recipient and marks it sent", async () => {
    const order = placeOrder(1, "Ali");
    const sent: { chatId: number; text: string }[] = [];
    const bot = {
      api: {
        sendMessage: async (chatId: number, text: string) => {
          sent.push({ chatId, text });
          return {};
        },
      },
    } as any;

    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    // Claim + enqueue the report, then run a tick to deliver it.
    reports.trySend(order.businessDate);
    await scheduler.tick();

    // The tick also catches up past dates, so scope to this report's content.
    const forThisReport = sent.filter((s) => s.text.includes(order.orderNumber));
    expect(forThisReport.map((s) => s.chatId).sort()).toEqual([111, 222]);
    expect(notif.allReportDelivered(order.businessDate)).toBe(true);
  });

  test("a delivery failure is retried (row returns to pending) and does not crash the tick", async () => {
    const order = placeOrder(1, "Ali");
    const bot = {
      api: {
        sendMessage: async () => {
          throw new Error("telegram 500");
        },
      },
    } as any;

    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    reports.trySend(order.businessDate);
    await scheduler.tick();

    const rows = db
      .query("SELECT status, attempts FROM notifications WHERE kind = 'daily_report' AND ref_key = ?")
      .all(order.businessDate) as { status: string; attempts: number }[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.status).toBe("pending"); // scheduled for retry
      expect(r.attempts).toBeGreaterThanOrEqual(1);
    }
    expect(notif.allReportDelivered(order.businessDate)).toBe(false);
  });
});
