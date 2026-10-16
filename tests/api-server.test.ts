import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { loadConfig } from "../src/config";
import { MenuService } from "../src/services/menu";
import { OrdersService } from "../src/services/orders";
import { CustomersService } from "../src/services/customers";
import { LoyaltyService } from "../src/services/loyalty";
import { BusinessHoursService } from "../src/services/business-hours";
import { ReportService } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";
import { createHttpServer } from "../src/api/server";
import { signInitData } from "../src/api/middleware/auth";
import { botState } from "../src/bot/state";
import type { ApiApp } from "../src/api/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end checks against the real Bun.serve handler for the production
 * failure modes: CORS preflight for the custom initData header, JSON (never
 * HTML) error bodies, and the 429 shape the Mini App parses.
 */

const BOT_TOKEN = "123456:TEST-SERVER-TOKEN";
const ADMIN = { id: 777, first_name: "Admin" };
const ORIGIN = "https://web.telegram.org";

let db: Db;
let server: ReturnType<typeof createHttpServer>;
let base: string;

beforeAll(() => {
  db = openDatabase(":memory:");
  const config = {
    ...loadConfig({
      BOT_TOKEN,
      ADMIN_IDS: "777",
      TIMEZONE: "Asia/Tehran",
      APP_BASE_URL: "https://cafe.example.com",
    }),
    // Port 0 => Bun picks a free port, so the test never collides with a
    // running dev server.
    httpPort: 0,
  };
  const businessHours = new BusinessHoursService(db, config.timezone);
  const menu = new MenuService(db);
  const orders = new OrdersService(db, businessHours);
  const notifications = new NotificationService(db);
  const reports = new ReportService(db, businessHours, notifications, config.timezone);
  const app: ApiApp = {
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
  server = createHttpServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("CORS preflight for x-telegram-init-data", () => {
  test("OPTIONS from Telegram Web is answered with the allowed headers", async () => {
    const res = await fetch(`${base}/api/admin/me`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-telegram-init-data",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-telegram-init-data");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("OPTIONS from an unknown origin gets no allow-origin header", async () => {
    const res = await fetch(`${base}/api/admin/me`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("real requests from Telegram Web carry CORS headers", async () => {
    const res = await fetch(`${base}/api/admin/me`, {
      headers: {
        origin: ORIGIN,
        "x-telegram-init-data": signInitData(BOT_TOKEN, ADMIN as any, Math.floor(Date.now() / 1000)),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("error responses are JSON, never HTML", () => {
  test("missing initData -> 401 JSON with an actionable message", async () => {
    const res = await fetch(`${base}/api/admin/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toContain("x-telegram-init-data");
  });

  test("unknown admin route -> 404 JSON", async () => {
    const res = await fetch(`${base}/api/admin/does-not-exist`, {
      headers: {
        "x-telegram-init-data": signInitData(BOT_TOKEN, ADMIN as any, Math.floor(Date.now() / 1000)),
      },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("rate-limited requests -> 429 JSON with Retry-After", async () => {
    const headers = {
      "x-telegram-init-data": signInitData(BOT_TOKEN, ADMIN as any, Math.floor(Date.now() / 1000)),
    };
    // The limiter allows 5000/min per IP; fire enough to trip it regardless of
    // how many requests earlier tests already consumed.
    const statuses: number[] = [];
    let limited: Response | null = null;
    for (let i = 0; i < 5010; i++) {
      const res = await fetch(`${base}/api/admin/me`, { headers });
      statuses.push(res.status);
      if (res.status === 429 && !limited) limited = res;
    }
    expect(statuses).toContain(429);
    expect(limited).not.toBeNull();
    expect(limited!.headers.get("content-type")).toContain("application/json");
    expect(limited!.headers.get("retry-after")).toBeTruthy();
    const body = await limited!.json();
    expect(body.code).toBe("RATE_LIMITED");
  });
});

describe("framing headers allow Telegram to embed the Mini App", () => {
  test("index.html has no X-Frame-Options and a Telegram-aware frame-ancestors", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://web.telegram.org");
  });

  test("health endpoint stays unauthenticated JSON", async () => {
    // botState is process-global and other test files (bot-startup) leave it in
    // a failed state, which makes /health answer 503. Pin it so this test
    // asserts the endpoint's contract rather than cross-file test ordering.
    const saved = { ...botState };
    botState.running = true;
    botState.failed = false;
    botState.lastError = null;
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.bot.status).toBe("running");
    } finally {
      Object.assign(botState, saved);
    }
  });

  test("health reports 503 when the bot has permanently failed", async () => {
    const saved = { ...botState };
    botState.running = false;
    botState.failed = true;
    botState.lastError = "401: Unauthorized";
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.bot.status).toBe("failed");
    } finally {
      Object.assign(botState, saved);
    }
  });
});

describe("DEBUG=true injects the eruda console", () => {
  let debugServer: ReturnType<typeof createHttpServer>;
  let debugBase: string;

  beforeAll(() => {
    const config = {
      ...loadConfig({
        BOT_TOKEN,
        ADMIN_IDS: "777",
        TIMEZONE: "Asia/Tehran",
        APP_BASE_URL: "https://cafe.example.com",
        DEBUG: "true",
      }),
      httpPort: 0,
    };
    const businessHours = new BusinessHoursService(db, config.timezone);
    const app: ApiApp = {
      config,
      db,
      menu: new MenuService(db),
      orders: new OrdersService(db, businessHours),
      businessHours,
      reports: new ReportService(db, businessHours, new NotificationService(db), config.timezone),
      notifications: new NotificationService(db),
      uploadsDir: mkdtempSync(join(tmpdir(), "cafe-uploads-")),
      customers: new CustomersService(db),
      loyalty: new LoyaltyService(db),
    };
    debugServer = createHttpServer(app);
    debugBase = `http://127.0.0.1:${debugServer.port}`;
  });

  afterAll(() => {
    debugServer.stop(true);
  });

  test("index.html carries the eruda snippet and a widened CSP", async () => {
    const res = await fetch(`${debugBase}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("https://cdn.jsdelivr.net/npm/eruda");
    expect(html).toContain("eruda.init();");
    expect(res.headers.get("content-security-policy")).toContain("https://cdn.jsdelivr.net");
  });

  test("static assets keep the production CSP", async () => {
    const res = await fetch(`${debugBase}/js/api.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).not.toContain("jsdelivr");
  });
});
