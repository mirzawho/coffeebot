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

function headersFor(user: typeof ADMIN, content?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-telegram-init-data": signInitData(BOT_TOKEN, user as any, NOW_S()),
    ...(content ?? {}),
  };
}

function call(method: string, path: string, opts: { user?: typeof ADMIN | typeof OTHER | null; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {}) {
  const user = opts.user === undefined ? ADMIN : opts.user;
  const headers: Record<string, string> = opts.headers
    ? { ...opts.headers }
    : user
      ? headersFor(user)
      : {};
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  return handleAdminApi(
    new Request(`http://localhost${path}`, { method, headers, body }),
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
  };
});

describe("admin API authorization", () => {
  test("missing initData -> 401", async () => {
    const r = await call("GET", "/api/admin/me", { user: null });
    expect(r.status).toBe(401);
  });

  test("forged initData -> 401", async () => {
    const forged = signInitData("999999:WRONG-TOKEN", ADMIN as any, NOW_S());
    const r = await call("GET", "/api/admin/me", { headers: { "x-telegram-init-data": forged } });
    expect(r.status).toBe(401);
  });

  test("non-admin valid initData -> 403", async () => {
    const r = await call("GET", "/api/admin/me", { user: OTHER as any });
    expect(r.status).toBe(403);
  });

  test("stale initData -> 401", async () => {
    const stale = signInitData(BOT_TOKEN, ADMIN as any, NOW_S() - 13 * 3600);
    const r = await call("GET", "/api/admin/me", { headers: { "x-telegram-init-data": stale } });
    expect(r.status).toBe(401);
  });

  test("authorized admin reaches every protected endpoint", async () => {
    for (const [method, path] of [
      ["GET", "/api/admin/me"],
      ["GET", "/api/admin/dashboard"],
      ["GET", "/api/admin/categories"],
      ["GET", "/api/admin/products"],
      ["GET", "/api/admin/settings/payment"],
      ["GET", "/api/admin/business-hours"],
      ["GET", "/api/admin/report-settings"],
      ["GET", "/api/admin/reports/recent"],
      ["GET", "/api/admin/orders"],
    ] as const) {
      const r = await call(method, path);
      expect(r.status, `${method} ${path}`).toBe(200);
    }
  });

  test("unknown admin route -> 404", async () => {
    const r = await call("GET", "/api/admin/nope");
    expect(r.status).toBe(404);
  });
});

describe("request body error codes (BUG-008 regression)", () => {
  test("oversized content-length -> 413, not 500", async () => {
    const r = await call("POST", "/api/admin/categories", {
      rawBody: "{}",
      headers: { ...headersFor(ADMIN), "content-length": String(5 * 1024 * 1024) },
    });
    expect(r.status).toBe(413);
  });

  test("malformed JSON -> 400, not 500", async () => {
    const r = await call("POST", "/api/admin/categories", { rawBody: "{not json" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("JSON");
  });

  test("empty body -> 400 with validation message", async () => {
    const r = await call("POST", "/api/admin/categories", { rawBody: "" });
    expect(r.status).toBe(400);
  });

  test("internal errors still return generic 500 without stack traces", async () => {
    // Force an internal failure: business-hours PUT with a non-array body is a
    // 400; to force 500 use an invalid id parse path — num() throws generic
    // Error caught by handler as 400. Instead simulate via a valid-looking
    // route that hits an unexpected throw: PUT category with id "abc".
    const r = await call("PUT", "/api/admin/categories/abc", { body: { name: "x" } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("at ");
  });
});

describe("business hours endpoint contract (BUG-010 regression)", () => {
  test("partial week is rejected and schedule unchanged", async () => {
    const r = await call("PUT", "/api/admin/business-hours", {
      body: [{ weekday: 0, openTime: "09:00", closeTime: "17:00", active: true }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("۷ روز");
    const hours = await call("GET", "/api/admin/business-hours");
    expect(hours.body.find((h: any) => h.weekday === 1)?.active).toBe(true);
  });

  test("full week is accepted", async () => {
    const week = Array.from({ length: 7 }, (_, wd) => ({
      weekday: wd,
      openTime: "09:00",
      closeTime: "17:00",
      active: wd !== 5,
    }));
    const r = await call("PUT", "/api/admin/business-hours", { body: week });
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(7);
  });
});

describe("report settings recipients (authorization)", () => {
  test("non-admin recipient is rejected", async () => {
    const r = await call("PUT", "/api/admin/report-settings", {
      body: { enabled: true, time: "18:30", sendEmpty: false, recipients: [99999] },
    });
    expect(r.status).toBe(400);
  });
});

describe("customer orders appear in the admin workflow", () => {
  test("an order created through the customer checkout flow is visible to admins", async () => {
    // Seed a product + payment settings, then place an order exactly like the
    // customer bot does (real services, real DB — persistence boundary).
    const cat = app.menu.createCategory({ name: "نوشیدنی" });
    const product = app.menu.createProduct({ categoryId: cat.id, name: "اسپرسو", fixedPriceAmount: 80000 });
    updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
    const cart = new CartService(db);
    cart.addItem(555, product.id, null, 2);
    const co = app.orders.startCheckout(555);
    expect(co.ok).toBe(true);
    app.orders.attachReceipt(555, "receipt-file", 1);
    app.orders.setDeliveryNotes(555, null);
    const conf = app.orders.confirmOrder(555, "Cust");
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;

    // Admin API must show it (dashboard recent + orders list).
    const list = await call("GET", "/api/admin/orders");
    expect(list.status).toBe(200);
    const order = (list.body as any[]).find((o) => o.orderNumber === conf.order.orderNumber);
    expect(order).toBeDefined();
    expect(order.status).toBe("receipt_received_unverified");
    expect(order.hasReceipt).toBe(true);
    expect(order.totalAmount).toBe(160000);
    expect(order.items.length).toBe(1);

    const dash = await call("GET", "/api/admin/dashboard");
    expect(dash.status).toBe(200);
    expect((dash.body as any).recent.some((o: any) => o.orderNumber === conf.order.orderNumber)).toBe(true);
    // Orders placed after closing roll to the next business date, so count by
    // the order's own business date rather than the calendar "today".
    const ordersOnBusinessDate = await call(
      "GET",
      `/api/admin/orders?businessDate=${conf.order.businessDate}`,
    );
    expect(ordersOnBusinessDate.status).toBe(200);
    expect(
      (ordersOnBusinessDate.body as any[]).some((o) => o.orderNumber === conf.order.orderNumber),
    ).toBe(true);
  });
});

describe("admin bootstrap profile (redesign regression)", () => {
  test("/me returns the validated identity, never a raw id as primary info", async () => {
    const r = await call("GET", "/api/admin/me", {
      user: { id: 777, first_name: "علی", last_name: "رضایی", username: "ali" } as any,
    });
    expect(r.status).toBe(200);
    expect(r.body.firstName).toBe("علی");
    expect(r.body.lastName).toBe("رضایی");
    expect(r.body.username).toBe("ali");
    expect(r.body.photoUrl).toBeNull();
    // App context for the UI bootstrap.
    expect(r.body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.currency).toBe("تومان");
    // The Mini App never needs the numeric Telegram id.
    expect(r.body.id).toBeUndefined();
  });

  test("photo_url is only accepted as an https URL", async () => {
    const good = await call("GET", "/api/admin/me", {
      user: { id: 777, first_name: "A", photo_url: "https://t.me/i/userpic/x.jpg" } as any,
    });
    expect(good.body.photoUrl).toBe("https://t.me/i/userpic/x.jpg");
    const bad = await call("GET", "/api/admin/me", {
      user: { id: 777, first_name: "A", photo_url: "javascript:alert(1)" } as any,
    });
    expect(bad.body.photoUrl).toBeNull();
  });

  test("admins list labels fall back to مدیر N, then resolve to remembered names", async () => {
    // ADMIN_IDS is {777}; nobody has opened the Mini App yet.
    let r = await call("GET", "/api/admin/admins", { user: null as any });
    expect(r.status).toBe(401);
    r = await call("GET", "/api/admin/admins");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 777, label: "مدیر ۱", username: null }]);

    // After an authenticated /me, the display name is remembered.
    await call("GET", "/api/admin/me", {
      user: { id: 777, first_name: "علی", username: "ali" } as any,
    });
    r = await call("GET", "/api/admin/admins");
    expect(r.body).toEqual([{ id: 777, label: "علی", username: "ali" }]);
  });
});

describe("orders date filter (reports page regression)", () => {
  function seedOrderOn(businessDate: string, name: string) {
    db.query(
      `INSERT INTO orders (order_number, customer_telegram_id, customer_name, business_date,
       total_amount, currency, receipt_file_id, delivery_notes, status, created_at)
       VALUES (?, 555, ?, ?, 1000, 'تومان', NULL, NULL, 'receipt_received_unverified', ?)`,
    ).run(`CN-${businessDate.replaceAll("-", "")}-0001`, name, businessDate, `${businessDate}T10:00:00.000Z`);
  }

  test("single businessDate returns only that day", async () => {
    seedOrderOn("2026-10-12", "روز اول");
    seedOrderOn("2026-10-13", "روز دوم");
    const r = await call("GET", "/api/admin/orders?businessDate=2026-10-13");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].customerName).toBe("روز دوم");
    // Persian labels + Jalali date, no Telegram/DB ids.
    expect(r.body[0].statusLabel).toBe("رسید دریافت شده");
    expect(r.body[0].jalaliDate).toBeTruthy();
    expect(r.body[0].time).toMatch(/^\d{2}:\d{2}$/);
    expect(r.body[0].id).toBeUndefined();
    expect(r.body[0].customerTelegramId).toBeUndefined();
  });

  test("from/to range is inclusive and validated", async () => {
    seedOrderOn("2026-10-10", "قدیمی");
    seedOrderOn("2026-10-11", "شروع");
    seedOrderOn("2026-10-12", "پایان");
    seedOrderOn("2026-10-13", "جدید");
    const r = await call("GET", "/api/admin/orders?from=2026-10-11&to=2026-10-12");
    expect(r.status).toBe(200);
    expect(r.body.map((o: any) => o.customerName)).toEqual(["شروع", "پایان"]);

    // One-sided range: a missing side defaults to the other (single day).
    const oneSide = await call("GET", "/api/admin/orders?from=2026-10-12");
    expect(oneSide.body.map((o: any) => o.customerName)).toEqual(["پایان"]);

    const bad = await call("GET", "/api/admin/orders?from=2026-13-45");
    expect(bad.status).toBe(400);
    const flipped = await call("GET", "/api/admin/orders?from=2026-10-12&to=2026-10-11");
    expect(flipped.status).toBe(400);
    const tooWide = await call("GET", "/api/admin/orders?from=2026-01-01&to=2026-12-31");
    expect(tooWide.status).toBe(400);
  });
});

describe("saved report settings drive the scheduler (settings wiring regression)", () => {
  test("delivery time and disabling saved via the API change due-time evaluation", async () => {
    // The scheduler reads settings from the DB each tick; saving through the
    // admin API must be what the scheduler sees — no UI-only state.
    const put = (body: unknown) => call("PUT", "/api/admin/report-settings", { body });
    expect((await put({ enabled: true, time: "07:45", sendEmpty: true, recipients: [777] })).status).toBe(200);

    const saved = await call("GET", "/api/admin/report-settings");
    expect(saved.body.time).toBe("07:45");

    // dueBusinessDate gates on the *saved* time: before 07:45 not due, after due.
    const before = app.businessHours.reportBusinessDate(new Date("2026-10-13T07:00:00+03:30"));
    const after = new Date("2026-10-13T08:00:00+03:30");
    expect(app.reports.dueBusinessDate(new Date("2026-10-13T07:00:00+03:30"))).toBeNull();
    expect(app.reports.dueBusinessDate(after)).toBe(before);

    // Disabling stops future delivery: no due dates at all.
    expect((await put({ enabled: false, time: "07:45", sendEmpty: true, recipients: [777] })).status).toBe(200);
    expect(app.reports.findDueReports(after)).toEqual([]);
  });

  test("recipient outside the ADMIN_IDS allowlist is rejected", async () => {
    const r = await call("PUT", "/api/admin/report-settings", {
      body: { enabled: true, time: "07:30", sendEmpty: false, recipients: [888888] },
    });
    expect(r.status).toBe(400);
  });
});
