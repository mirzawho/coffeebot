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
        sendPhoto: async () => ({}),
      },
    } as any;

    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    // Claim + enqueue the report, then run a tick to deliver it.
    reports.trySend(order.businessDate);
    await scheduler.tick();

    // The tick also catches up past dates, and card orders carry their own
    // order_update notice — scope to the recipients, not the message count.
    const forThisReport = sent.filter((s) => s.text.includes(order.orderNumber));
    expect([...new Set(forThisReport.map((s) => s.chatId))].sort()).toEqual([111, 222]);
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

describe("receipt review forwarding", () => {
  test("order_update forwards the receipt photo with تأیید/لغو buttons", async () => {
    const order = placeOrder(1, "Ali");
    const photos: { chatId: number; fileId: string; kb: any }[] = [];
    const bot = {
      api: {
        sendMessage: async () => ({}),
        sendPhoto: async (chatId: number, fileId: string, opts: any) => {
          photos.push({ chatId, fileId, kb: opts?.reply_markup });
          return {};
        },
      },
    } as any;
    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    await scheduler.tick();

    expect(photos.length).toBe(2); // both report recipients
    expect(photos[0]!.fileId).toBe("file-1");
    const cbs = photos[0]!.kb.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(cbs).toEqual([`oa:yes:${order.id}`, `oa:no:${order.id}`]);
  });

  test("a failed receipt photo falls back to a text message with the same buttons", async () => {
    const order = placeOrder(1, "Ali");
    const msgs: { text: string; kb: any }[] = [];
    const bot = {
      api: {
        sendMessage: async (_chat: number, text: string, opts?: any) => {
          msgs.push({ text, kb: opts?.reply_markup });
          return {};
        },
        sendPhoto: async () => {
          throw new Error("telegram: failed to get file");
        },
      },
    } as any;
    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    await scheduler.tick();

    const fallback = msgs.find((m) => m.kb?.inline_keyboard);
    expect(fallback).toBeDefined();
    const cbs = fallback!.kb.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(cbs).toEqual([`oa:yes:${order.id}`, `oa:no:${order.id}`]);
  });

  test("customer_notice with a photo is one sendPhoto (reason rides as the caption)", async () => {
    const photos: { chatId: number; caption: string }[] = [];
    const bot = {
      api: {
        sendMessage: async () => ({}),
        sendPhoto: async (chatId: number, _file: string, opts: any) => {
          photos.push({ chatId, caption: opts?.caption });
          return {};
        },
      },
    } as any;
    notif.enqueue("customer_notice", "payment_rejected_CN-1", [555], {
      text: "⚠️ رسید تأیید نشد.\n\nدلیل: مبلغ کم است",
      photoFileId: "receipt-abc",
    });
    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    await scheduler.tick();

    expect(photos).toEqual([{ chatId: 555, caption: "⚠️ رسید تأیید نشد.\n\nدلیل: مبلغ کم است" }]);
  });

  test("customer_notice without a photo still uses sendMessage", async () => {
    const texts: { chatId: number; text: string }[] = [];
    const bot = {
      api: {
        sendMessage: async (chatId: number, text: string) => {
          texts.push({ chatId, text });
          return {};
        },
        sendPhoto: async () => ({}),
      },
    } as any;
    notif.enqueue("customer_notice", "payment_approved_CN-2", [555], {
      text: "✅ پرداخت تأیید شد.",
    });
    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });
    await scheduler.tick();

    expect(texts.some((t) => t.chatId === 555 && t.text === "✅ پرداخت تأیید شد.")).toBe(true);
  });
});
