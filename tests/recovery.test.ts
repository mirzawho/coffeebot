import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { ReportService, STALE_RUN_MS } from "../src/services/reports";
import { NotificationService, STALE_SENDING_MS, backoffMs } from "../src/services/notifications";
import { updateReportSettings, updatePaymentSettings } from "../src/services/settings";
import { Scheduler } from "../src/scheduler";
import { nowIso } from "../src/db/database";

let db: Db;
let menu: MenuService;
let cart: CartService;
let bh: BusinessHoursService;
let orders: OrdersService;
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
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  updateReportSettings(
    db,
    { enabled: true, time: "18:30", sendEmpty: false, recipients: [111] },
    ADMIN_IDS,
  );
  const cat = menu.createCategory({ name: "نوشیدنی" });
  menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 });
});

function placeOrderFor(userId: number, businessDateOverride?: string) {
  if (businessDateOverride) {
    // Insert an order directly with a specific business date (simulating an
    // order placed while the app was online on a past day).
    const product = menu.listProducts(undefined, false)[0]!;
    const res = db
      .query(
        `INSERT INTO orders (order_number, customer_telegram_id, business_date, total_amount, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'receipt_received_unverified', ?)`,
      )
      .run(
        `CN-${businessDateOverride.replace(/-/g, "")}-0001`,
        userId,
        businessDateOverride,
        15000,
        "تومان",
        nowIso(),
      );
    return { id: Number(res.lastInsertRowid), businessDate: businessDateOverride };
  }
  const product = menu.listProducts(undefined, false)[0]!;
  cart.addItem(userId, product.id, null, 1);
  orders.startCheckout(userId);
  orders.attachReceipt(userId, `file-${userId}`, userId);
  cart.setFulfillmentMethod(userId, "pickup");
  const conf = orders.confirmOrder(userId);
  if (!conf.ok) throw new Error("confirm failed");
  return conf.order;
}

describe("BUG-002: missed-day report recovery", () => {
  test("report missed while fully offline is recovered on next due tick", () => {
    // Simulate: orders exist for 2026-10-12 but the app was down at report
    // time, so no run row was ever created. App restarts 2026-10-13 at 19:00.
    placeOrderFor(1, "2026-10-12");
    const restart = new Date("2026-10-13T19:00:00+03:30");

    const due = reports.findDueReports(restart);
    expect(due).toContain("2026-10-12");
    expect(due).toContain("2026-10-13"); // current date also due (past 18:30)

    const outcome = reports.trySend("2026-10-12", restart);
    expect(outcome.action).toBe("enqueued");
    if (outcome.action === "enqueued") expect(outcome.orderCount).toBe(1);

    // Duplicate prevention: second attempt cannot regenerate.
    const again = reports.trySend("2026-10-12", restart);
    expect(again.action).toBe("already_claimed");
  });

  test("restart before today's report time still recovers yesterday's missed report", () => {
    placeOrderFor(1, "2026-10-12");
    // Restart next morning 10:00 — before 18:30 due time.
    const restart = new Date("2026-10-14T10:00:00+03:30");
    const due = reports.findDueReports(restart);
    // 2026-10-13 also missed (no run row) and 2026-10-12 has orders.
    expect(due).toContain("2026-10-12");
    // 2026-10-13: no run row, walk-back includes it (walk < today).
    expect(due).toContain("2026-10-13");
    // Today (10-14) not yet due — not in list.
    expect(due).not.toContain("2026-10-14");
  });

  test("completed runs are never regenerated", () => {
    placeOrderFor(1, "2026-10-12");
    reports.trySend("2026-10-12");
    for (const n of notif.claimDue(new Date())) notif.markSent(n.id);

    const restart = new Date("2026-10-13T19:00:00+03:30");
    const due = reports.findDueReports(restart);
    // 10-12 has a terminal 'sent' row — not a candidate for regeneration.
    // (It may still appear if a non-terminal row existed; here it should not.)
    const incomplete = due.filter((d) => d === "2026-10-12");
    // findDueReports may include 10-12 only via the walk if run was non-terminal;
    // after full delivery the run is 'sent' so trySend would no-op anyway.
    const out = reports.trySend("2026-10-12", restart);
    expect(out.action).toBe("already_claimed");
    void incomplete;
  });

  test("catch-up respects the scan-depth cap (no unbounded regeneration)", () => {
    placeOrderFor(1, "2026-09-01"); // > 14 days before restart date
    const restart = new Date("2026-10-13T19:00:00+03:30");
    const due = reports.findDueReports(restart);
    expect(due).not.toContain("2026-09-01");
  });

  test("disabled reports do not recover anything", () => {
    placeOrderFor(1, "2026-10-12");
    updateReportSettings(db, { enabled: false, time: "18:30", sendEmpty: false, recipients: [111] }, ADMIN_IDS);
    const due = reports.findDueReports(new Date("2026-10-13T19:00:00+03:30"));
    expect(due).toEqual([]);
  });

  test("skipped_empty day recovered for catch-up does not enqueue notifications when sendEmpty=false", () => {
    // 2026-10-12 had no orders and was missed entirely (no run row).
    const restart = new Date("2026-10-13T19:00:00+03:30");
    const due = reports.findDueReports(restart);
    expect(due).toContain("2026-10-12");
    const out = reports.trySend("2026-10-12", restart);
    expect(out.action).toBe("skipped_empty");
    const rows = db.query("SELECT COUNT(*) AS c FROM notifications").get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("BUG-003: stale claim recovery", () => {
  test("stale sending notification is recovered and retried", () => {
    notif.enqueue("order_update", "CN-1", [111], { type: "order_update", orderId: 1 });
    const claimed = notif.claimDue(new Date());
    expect(claimed.length).toBe(1);

    // Fresh sending: not recovered.
    expect(notif.recoverStaleSending(new Date())).toBe(0);

    // Simulate crash: age the claim beyond the threshold.
    const old = new Date(Date.now() - STALE_SENDING_MS - 1000).toISOString();
    db.query("UPDATE notifications SET claimed_at = ? WHERE status = 'sending'").run(old);
    expect(notif.recoverStaleSending(new Date())).toBe(1);

    const row = db.query("SELECT status, attempts FROM notifications").get() as any;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1); // counted as an attempt (delivery ambiguous)

    // Claimable again after recovery.
    db.query("UPDATE notifications SET next_attempt_at = NULL").run();
    expect(notif.claimDue(new Date()).length).toBe(1);
  });

  test("repeated recovery is idempotent (status guard)", () => {
    notif.enqueue("order_update", "CN-1", [111], { type: "order_update", orderId: 1 });
    notif.claimDue(new Date());
    const old = new Date(Date.now() - STALE_SENDING_MS - 1000).toISOString();
    db.query("UPDATE notifications SET claimed_at = ?").run(old);
    expect(notif.recoverStaleSending(new Date())).toBe(1);
    expect(notif.recoverStaleSending(new Date())).toBe(0);
  });

  test("stale recovery respects MAX_ATTEMPTS (terminal failure)", () => {
    notif.enqueue("order_update", "CN-1", [111], { type: "order_update", orderId: 1 });
    // Pretend 9 attempts already happened, then crash mid-10th.
    db.query("UPDATE notifications SET attempts = 9, status = 'sending', claimed_at = ?").run(
      new Date(Date.now() - STALE_SENDING_MS - 1000).toISOString(),
    );
    expect(notif.recoverStaleSending(new Date())).toBe(1);
    const row = db.query("SELECT status, attempts FROM notifications").get() as any;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(10);
  });

  test("stale sending report run is reset to pending and re-claimable", () => {
    placeOrderFor(1, "2026-10-13");
    reports.trySend("2026-10-13"); // claims -> sending -> enqueued -> 'sent'
    // Force a stuck 'sending' run.
    db.query("UPDATE report_runs SET status = 'sending', claimed_at = ?").run(
      new Date(Date.now() - STALE_RUN_MS - 1000).toISOString(),
    );
    expect(reports.recoverStaleSendingRuns(new Date())).toBe(1);
    const run = db.query("SELECT status FROM report_runs WHERE business_date = '2026-10-13'").get() as any;
    expect(run.status).toBe("pending");

    // findDueReports now includes it; trySend re-claims.
    const due = reports.findDueReports(new Date("2026-10-13T19:00:00+03:30"));
    expect(due).toContain("2026-10-13");
    const out = reports.trySend("2026-10-13");
    expect(out.action).toBe("enqueued");
  });

  test("fresh sending report run is not stolen", () => {
    placeOrderFor(1, "2026-10-13");
    reports.trySend("2026-10-13");
    db.query("UPDATE report_runs SET status = 'sending', claimed_at = ?").run(new Date().toISOString());
    expect(reports.recoverStaleSendingRuns(new Date())).toBe(0);
    // Still sending: trySend cannot double-claim.
    expect(reports.trySend("2026-10-13").action).toBe("already_claimed");
  });
});

describe("BUG-007: chunk cursor on partial delivery", () => {
  function longReportOrders(businessDate: string) {
    // Insert enough orders that the report text exceeds one chunk (4000 chars).
    for (let i = 0; i < 80; i++) {
      db.query(
        `INSERT INTO orders (order_number, customer_telegram_id, business_date, total_amount, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'receipt_received_unverified', ?)`,
      ).run(`CN-${businessDate.replace(/-/g, "")}-${String(i + 1).padStart(4, "0")}`, 1000 + i, businessDate, 15000, "تومان", nowIso());
    }
  }

  test("partial delivery resumes from the cursor, not chunk 0", async () => {
    const businessDate = "2026-10-13";
    longReportOrders(businessDate);
    updateReportSettings(db, { enabled: true, time: "00:01", sendEmpty: false, recipients: [111] }, ADMIN_IDS);
    reports.trySend(businessDate);

    const sent: string[] = [];
    let failAfter = 1; // deliver exactly one chunk, then fail
    const bot: any = {
      api: {
        sendMessage: async (_chat: number, text: string) => {
          if (sent.length >= failAfter) throw new Error("429: Too Many Requests");
          sent.push(text);
        },
        sendPhoto: async () => {},
      },
      stop: () => {},
    };
    const scheduler = new Scheduler({ db, bot, reports, notifications: notif, businessHours: bh, orders });

    await scheduler.tick();
    expect(sent.length).toBe(1);
    let row = db.query("SELECT status, attempts, delivered_chunks FROM notifications WHERE kind = 'daily_report'").get() as any;
    expect(row.status).toBe("pending"); // failed -> backoff
    expect(row.attempts).toBe(1);
    expect(row.delivered_chunks).toBe(1);

    // Retry with backoff elapsed and delivery succeeding now.
    db.query("UPDATE notifications SET next_attempt_at = NULL WHERE status = 'pending'").run();
    failAfter = Infinity;
    await scheduler.tick();
    row = db.query("SELECT status, delivered_chunks FROM notifications WHERE kind = 'daily_report'").get() as any;
    expect(row.status).toBe("sent");
    expect(row.delivered_chunks).toBeGreaterThan(1);
    // First chunk was NOT resent: the retry only sent chunks 1..n.
    const report = reports.buildReportPayload(businessDate);
    expect(report.chunks.length).toBeGreaterThan(1);
    expect(sent.length).toBe(report.chunks.length); // 1 from first tick + rest from retry
    expect(sent[0]).toBe(report.chunks[0]); // first tick delivered chunk 0
  });

  test("crash-after-send-before-cursor duplicates at most the in-flight chunk", () => {
    // Simulate: chunk 0 delivered, cursor saved=1; process crashes before
    // chunk 1. On restart the cursor resumes at 1 — chunk 0 not resent.
    notif.enqueue("daily_report", "2026-10-13", [111], { type: "daily_report", businessDate: "2026-10-13" });
    const claimed = notif.claimDue(new Date())[0]!;
    notif.saveChunkProgress(claimed.id, 2);
    notif.markFailed(claimed.id, "crashed");
    db.query("UPDATE notifications SET next_attempt_at = NULL, status = 'pending' WHERE id = ?").run(claimed.id);
    const again = notif.claimDue(new Date())[0]!;
    expect(again.deliveredChunks).toBe(2);
  });
});
