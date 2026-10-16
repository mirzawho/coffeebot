import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ApiApp } from "../context";
import {
  AuthError,
  extractInitData,
  requireAdmin,
  validateInitData,
  type TelegramUser,
} from "../middleware/auth";
import {
  adminDisplayName,
  getAdminProfiles,
  getAiSettings,
  getCurrency,
  getNotificationSettings,
  getPaymentSettings,
  getReportSettings,
  rememberAdminProfile,
  updateAiSettings,
  updateNotificationSettings,
  updatePaymentSettings,
  updateReportSettings,
  getSetting,
} from "../../services/settings";
import { formatMoney, parseAmountInput } from "../../utils/money";
import { formatJalaliFa, isValidDate } from "../../utils/dates";
import { log } from "../../utils/logger";
import type { Order } from "../../services/orders";

interface RouteCtx {
  app: ApiApp;
  user: TelegramUser;
  req: Request;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: RouteCtx) => Promise<Response> | Response;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

/** Error carrying an HTTP status for API responses (no stack/detail leakage). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function readJson(req: Request): Promise<any> {
  // Keep in sync with the server's maxRequestBodySize: image uploads are
  // base64-in-JSON (~2.7MB for a 2MB image).
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 4 * 1024 * 1024) throw new HttpError(413, "payload too large");
  const text = await req.text();
  if (text.length > 4 * 1024 * 1024) throw new HttpError(413, "payload too large");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON نامعتبر است");
  }
}

function authenticate(req: Request, app: ApiApp): TelegramUser {
  const initData = extractInitData(req, { allowQuery: app.config.allowInitDataQuery });
  if (!initData) {
    // Diagnostic: distinguish "header never sent by the client" from "header
    // lost in transit" (redirect, nginx proxy_set_header inheritance, CORS
    // preflight). Headers are redacted — only presence/absence and initData
    // candidates are logged, never their values.
    const headerKeys: string[] = [];
    req.headers.forEach((_v, k) => headerKeys.push(k));
    const auth = req.headers.get("authorization");
    log.warn("admin request without initData", {
      method: req.method,
      url: req.url,
      origin: req.headers.get("origin") || null,
      referer: req.headers.get("referer") || null,
      forwardedFor: req.headers.get("x-forwarded-for") || null,
      forwardedProto: req.headers.get("x-forwarded-proto") || null,
      hasInitDataHeader: !!req.headers.get("x-telegram-init-data"),
      hasAuthorization: !!auth,
      allowQuery: app.config.allowInitDataQuery,
      headerKeys,
    });
    // Actionable message: the Mini App shows this verbatim, so it must tell the
    // operator what to do rather than just naming the missing header.
    throw new AuthError(
      "missing x-telegram-init-data header — open the panel from inside the Telegram bot",
    );
  }
  const validated = validateInitData(initData, app.config.botToken);
  return requireAdmin(validated, app.config.adminIds);
}

function num(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error("شناسه نامعتبر است");
  return n;
}

const routes: { method: string; rx: RegExp; handler: Handler }[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  const rx = new RegExp(
    "^" + pattern.replace(/:[a-zA-Z]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`) + "$",
  );
  routes.push({ method, rx, handler });
}

/** Persian labels for order statuses — the UI never shows raw codes. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  receipt_received_unverified: "رسید دریافت شده",
};

const FULFILLMENT_LABELS: Record<string, string> = {
  pending: "در انتظار آماده‌سازی",
  confirmed: "تأیید شده",
  delivered: "تحویل شده",
  cancelled: "لغو شده",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unverified: "تأیید نشده",
  receipt_received: "رسید دریافت شده",
  paid: "پرداخت شده",
  rejected: "رسید رد شده",
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card_to_card: "کارت به کارت",
  wallet: "کیف پول",
};

const FULFILLMENT_METHOD_LABELS: Record<string, string> = {
  delivery: "ارسال 🛵",
  pickup: "تحویل حضوری 🏪",
};

/** Persian labels for wallet ledger kinds. */
const WALLET_TX_LABELS: Record<string, string> = {
  deposit: "واریز به کیف پول",
  order_payment: "پرداخت سفارش",
  refund: "بازگشت وجه",
  adjustment: "تنظیم موجودی",
};

/** Admin-facing order shape: no DB ids, no Telegram ids. `statusLabel` is what
 * the UI shows; the raw `status` stays for API compatibility/consumers. */
function orderDto(o: Order, timezone: string) {
  return {
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    businessDate: o.businessDate,
    jalaliDate: formatJalaliFa(o.businessDate),
    time: isoToLocalTime(o.createdAt, timezone),
    totalAmount: o.totalAmount,
    currency: o.currency,
    status: o.status,
    statusLabel: ORDER_STATUS_LABELS[o.status] ?? "ثبت شده",
    fulfillmentLabel: FULFILLMENT_LABELS[o.fulfillmentStatus] ?? "ثبت شده",
    paymentLabel: PAYMENT_STATUS_LABELS[o.paymentStatus] ?? "—",
    paymentMethodLabel: PAYMENT_METHOD_LABELS[o.paymentMethod] ?? "—",
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    deliveryNotes: o.deliveryNotes,
    fulfillmentMethod: o.fulfillmentMethod,
    fulfillmentMethodLabel: FULFILLMENT_METHOD_LABELS[o.fulfillmentMethod] ?? "—",
    deliveryTime: o.deliveryTime,
    hasReceipt: !!o.receiptFileId,
    items: o.items.map((it) => ({
      productName: it.productName,
      variantName: it.variantName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
    })),
  };
}

/** HH:MM of an ISO instant in the cafe's timezone. */
function isoToLocalTime(iso: string, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return fmt.format(new Date(iso));
}

/** "YYYY-MM-DD HH:MM" of an ISO instant in the cafe's timezone. */
function isoToLocalDateTime(iso: string, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // en-GB renders DD/MM/YYYY — rebuild as YYYY-MM-DD HH:MM.
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(iso))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function localDate(app: ApiApp, now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: app.config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now); // en-CA => YYYY-MM-DD
}

// ---- routes ----

/**
 * Bootstrap for the Mini App: the *validated* Telegram identity of the
 * currently authenticated admin (never client-supplied), plus app context the
 * UI needs to render (current business date, currency). Remembers the display
 * name so other admins' recipient labels can resolve to real names.
 */
route("GET", "/api/admin/me", ({ app, user }) => {
  rememberAdminProfile(app.db, user);
  return json({
    firstName: user.first_name,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    photoUrl: user.photo_url ?? null,
    businessDate: localDate(app),
    currency: getPaymentSettings(app.db).currency,
  });
});

/**
 * Configured administrators with human labels for the report-recipient
 * selector. Falls back to «مدیر N» (allowlist position) when a name has never
 * been seen; raw ids are values here, never display labels in the UI.
 */
route("GET", "/api/admin/admins", ({ app }) => {
  const profiles = getAdminProfiles(app.db);
  return json(
    [...app.config.adminIds].map((id, i) => ({
      id,
      label: adminDisplayName(profiles, id, i),
      username: profiles[id]?.username ?? null,
    })),
  );
});

route("GET", "/api/admin/dashboard", ({ app }) => {
  const date = localDate(app);
  const reportSettings = getReportSettings(app.db);
  const notif = app.notifications.counts();
  return json({
    businessDate: date,
    todayOrders: app.orders.countByBusinessDate(date),
    recent: app.orders.listRecent(10).map((o) => orderDto(o, app.config.timezone)),
    report: {
      enabled: reportSettings.enabled,
      time: reportSettings.time,
      recipients: reportSettings.recipients,
      lastStatus: getSetting(app.db, "last_report_status"),
      lastError: getSetting(app.db, "last_report_error"),
      pendingNotifications: notif.pending,
      failedNotifications: notif.failed,
    },
  });
});

// categories

route("GET", "/api/admin/categories", ({ app }) => json(app.menu.listCategories(true)));

route("POST", "/api/admin/categories", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(
      app.menu.createCategory({ name: body.name, sortOrder: body.sortOrder, active: body.active }),
      201,
    );
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

route("PUT", "/api/admin/categories/:id", async ({ app, req, params }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(app.menu.updateCategory(num(params.id), body));
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

route("DELETE", "/api/admin/categories/:id", ({ app, params }) => {
  try {
    app.menu.deleteCategory(num(params.id));
    return json({ ok: true });
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// products

route("GET", "/api/admin/products", ({ app, url }) => {
  const catIdRaw = url.searchParams.get("categoryId");
  const categoryId = catIdRaw ? num(catIdRaw) : undefined;
  return json(app.menu.listProducts(categoryId, true));
});

route("GET", "/api/admin/products/:id", ({ app, params }) => {
  const p = app.menu.getProduct(num(params.id), true);
  if (!p) return json({ error: "محصول یافت نشد" }, 404);
  return json(p);
});

route("POST", "/api/admin/products", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    const fixed =
      body.fixedPriceAmount === undefined ||
      body.fixedPriceAmount === null ||
      body.fixedPriceAmount === ""
        ? null
        : parseAmountInput(body.fixedPriceAmount);
    const p = app.menu.createProduct({
      categoryId: num(String(body.categoryId)),
      name: body.name,
      description: body.description,
      fixedPriceAmount: fixed,
      sortOrder: body.sortOrder,
      active: body.active,
    });
    return json(p, 201);
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

route("PUT", "/api/admin/products/:id", async ({ app, req, params }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    const patch: any = { ...body };
    if ("fixedPriceAmount" in body) {
      patch.fixedPriceAmount =
        body.fixedPriceAmount === null || body.fixedPriceAmount === ""
          ? null
          : parseAmountInput(body.fixedPriceAmount);
    }
    if (body.categoryId !== undefined) patch.categoryId = num(String(body.categoryId));
    return json(app.menu.updateProduct(num(params.id), patch));
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

route("DELETE", "/api/admin/products/:id", ({ app, params }) => {
  try {
    app.menu.deleteProduct(num(params.id));
    return json({ ok: true });
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// product images (base64 upload; files live on the data volume)

route("POST", "/api/admin/products/:id/image", async ({ app, req, params }) => {
  const id = num(params.id);
  const product = app.menu.getProduct(id, true);
  if (!product) return json({ error: "محصول یافت نشد" }, 404);
  const body = await readJson(req);
  if (!body || typeof body.dataBase64 !== "string") return badRequest("dataBase64 الزامی است");
  const mime = String(body.mime ?? "image/jpeg");
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return badRequest("فقط jpeg/png/webp");
  const buf = Buffer.from(body.dataBase64, "base64");
  if (buf.length === 0) return badRequest("فایل خالی است");
  if (buf.length > MAX_IMAGE_BYTES) return badRequest("حجم تصویر بیش از حد مجاز است (۲ مگابایت)");
  mkdirSync(app.uploadsDir, { recursive: true });
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const fileName = `product-${id}-${Date.now()}.${ext}`;
  writeFileSync(join(app.uploadsDir, fileName), buf);
  const oldPath = product.imagePath;
  const updated = app.menu.updateProduct(id, { imagePath: `uploads/${fileName}` });
  // DB update succeeded; remove the previous file (best-effort, observable).
  cleanupOldImage(app.uploadsDir, oldPath);
  return json(updated);
});

route("DELETE", "/api/admin/products/:id/image", ({ app, params }) => {
  try {
    const product = app.menu.getProduct(num(params.id), true);
    if (!product) return json({ error: "محصول یافت نشد" }, 404);
    const updated = app.menu.updateProduct(num(params.id), { imagePath: null });
    cleanupOldImage(app.uploadsDir, product.imagePath);
    return json(updated);
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

/** Best-effort removal of a superseded product image; never throws. */
function cleanupOldImage(uploadsDir: string, imagePath: string | null): void {
  if (!imagePath) return;
  const base = imagePath.split("/").pop() ?? "";
  if (!base || base.includes("..") || base.includes("/")) return;
  const abs = join(uploadsDir, base);
  if (!abs.startsWith(uploadsDir + "/")) return;
  try {
    unlinkSync(abs);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("product image cleanup failed", { file: base, err: String(err) });
    }
  }
}

// variants

route("GET", "/api/admin/products/:id/variants", ({ app, params }) =>
  json(app.menu.getVariants(num(params.id), true)),
);

route("POST", "/api/admin/variants", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(
      app.menu.createVariant({
        productId: num(String(body.productId)),
        name: body.name,
        priceAmount: parseAmountInput(body.priceAmount),
        sortOrder: body.sortOrder,
        active: body.active,
      }),
      201,
    );
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

route("PUT", "/api/admin/variants/:id", async ({ app, req, params }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    const patch: any = { ...body };
    if (body.priceAmount !== undefined) patch.priceAmount = parseAmountInput(body.priceAmount);
    return json(app.menu.updateVariant(num(params.id), patch));
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

route("DELETE", "/api/admin/variants/:id", ({ app, params }) => {
  try {
    app.menu.deleteVariant(num(params.id));
    return json({ ok: true });
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// payment settings

route("GET", "/api/admin/settings/payment", ({ app }) => json(getPaymentSettings(app.db)));

route("PUT", "/api/admin/settings/payment", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(
      updatePaymentSettings(app.db, {
        cardNumber: String(body.cardNumber ?? ""),
        cardholderName: String(body.cardholderName ?? ""),
        currency: String(body.currency ?? ""),
        cardToCardEnabled:
          body.cardToCardEnabled !== undefined ? !!body.cardToCardEnabled : undefined,
        walletEnabled: body.walletEnabled !== undefined ? !!body.walletEnabled : undefined,
      }),
    );
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// business hours

route("GET", "/api/admin/business-hours", ({ app }) => json(app.businessHours.getHours()));

route("PUT", "/api/admin/business-hours", async ({ app, req }) => {
  const body = await readJson(req);
  if (!Array.isArray(body)) return badRequest("آرایه‌ای از روزها انتظار می‌رود");
  try {
    return json(app.businessHours.saveHours(body));
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// report settings

route("GET", "/api/admin/report-settings", ({ app }) => json(getReportSettings(app.db)));

route("PUT", "/api/admin/report-settings", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(
      updateReportSettings(
        app.db,
        {
          enabled: !!body.enabled,
          time: String(body.time ?? ""),
          sendEmpty: !!body.sendEmpty,
          recipients: Array.isArray(body.recipients)
            ? body.recipients.map((n: unknown) => Number(n)).filter(Number.isInteger)
            : [],
        },
        app.config.adminIds,
      ),
    );
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// reports

route("GET", "/api/admin/reports/recent", ({ app }) =>
  json({
    runs: app.reports.recentRuns(14),
    lastStatus: getSetting(app.db, "last_report_status"),
    lastError: getSetting(app.db, "last_report_error"),
  }),
);

route("POST", "/api/admin/reports/test", ({ app }) =>
  json(app.reports.trySend(app.businessHours.reportBusinessDate(new Date()))),
);

// orders (admin read-only)

/**
 * Orders for the reports page. `businessDate` selects one business day;
 * `from`/`to` (inclusive, either may be omitted) select a range. The range is
 * capped so a mistyped request cannot dump unbounded history into the panel.
 */
const MAX_RANGE_DAYS = 31;

route("GET", "/api/admin/orders", ({ app, url }) => {
  const tz = app.config.timezone;
  const date = url.searchParams.get("businessDate");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (date) {
    if (!isValidDate(date)) return badRequest("تاریخ نامعتبر است");
    return json(app.orders.listByBusinessDate(date).map((o) => orderDto(o, tz)));
  }

  if (from || to) {
    const start = from || to!;
    const end = to || from!;
    if (!isValidDate(start) || !isValidDate(end)) return badRequest("تاریخ نامعتبر است");
    if (start > end) return badRequest("تاریخ شروع باید قبل از تاریخ پایان باشد");
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) return badRequest("بازه انتخاب‌شده بیش از حد مجاز است (حداکثر ۳۱ روز)");
    return json(app.orders.listByDateRange(start, end, 200).map((o) => orderDto(o, tz)));
  }

  return json(app.orders.listRecent(50).map((o) => orderDto(o, tz)));
});

// AI settings (admin-only; persona is style guidance, never permissions)

route("GET", "/api/admin/ai-settings", ({ app }) => json(getAiSettings(app.db)));

route("PUT", "/api/admin/ai-settings", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(
      updateAiSettings(app.db, {
        enabled: body.enabled !== undefined ? !!body.enabled : undefined,
        persona: body.persona !== undefined ? String(body.persona ?? "") : undefined,
        replyLength: body.replyLength !== undefined ? String(body.replyLength) : undefined,
        personalizeGreeting:
          body.personalizeGreeting !== undefined ? !!body.personalizeGreeting : undefined,
        suggestUsual: body.suggestUsual !== undefined ? !!body.suggestUsual : undefined,
        streaming: body.streaming !== undefined ? !!body.streaming : undefined,
      }),
    );
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// customer notification toggles

route("GET", "/api/admin/notification-settings", ({ app }) =>
  json(getNotificationSettings(app.db)),
);

route("PUT", "/api/admin/notification-settings", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    return json(
      updateNotificationSettings(app.db, {
        notifyOrderConfirmed:
          body.notifyOrderConfirmed !== undefined ? !!body.notifyOrderConfirmed : undefined,
        askDeliveryRating: body.askDeliveryRating !== undefined ? !!body.askDeliveryRating : undefined,
      }),
    );
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

// wallet deposit review (admin)

route("GET", "/api/admin/wallet/deposits", ({ app, url }) => {
  const status = url.searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "rejected", "all"].includes(status)) {
    return badRequest("وضعیت نامعتبر است");
  }
  const deposits = app.customers.listAllDeposits(status as any, 50);
  return json(
    deposits.map((d) => {
      const profile = app.customers.getProfile(d.telegramId);
      return {
        id: d.id,
        amount: d.amount,
        status: d.status,
        hasReceipt: !!d.receiptFileId,
        createdAt: d.createdAt,
        customer: {
          telegramId: d.telegramId,
          name: profile?.fullName ?? null,
          phone: profile?.phone ?? null,
        },
      };
    }),
  );
});

route("GET", "/api/admin/wallet/deposits/:id/receipt", ({ app, params }) => {
  const d = app.customers.getDeposit(num(params.id));
  if (!d || !d.receiptFileId) return json({ error: "رسیدی ثبت نشده است" }, 404);
  return json({ fileId: d.receiptFileId });
});

route("POST", "/api/admin/wallet/deposits/:id/approve", ({ app, user, params }) => {
  const id = num(params.id);
  const r = app.customers.approveDeposit(id, user.id);
  if (!r.ok) return badRequest(r.error);
  const deposit = app.customers.getDeposit(id);
  return json({ ok: true, balance: deposit ? app.customers.getBalance(deposit.telegramId) : 0 });
});

route("POST", "/api/admin/wallet/deposits/:id/reject", ({ app, user, params }) => {
  const r = app.customers.rejectDeposit(num(params.id), user.id);
  if (!r.ok) return badRequest(r.error);
  return json({ ok: true });
});

// customer list + detail (admin)

/**
 * Customer directory for the panel: profile, wallet balance, order stats.
 * Telegram ids are values here, never display labels (the UI shows names).
 */
route("GET", "/api/admin/customers", ({ app, url }) => {
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const rows = app.customers.listCustomerRows(limit);
  const tz = app.config.timezone;
  const filtered = q
    ? rows.filter((r) => {
        const name = r.fullName ?? "";
        return (
          name.includes(q) ||
          (r.phone ?? "").includes(q) ||
          (r.username ?? "").toLowerCase().includes(q.toLowerCase())
        );
      })
    : rows;
  return json(
    filtered.map((r) => ({
      // The id is the route parameter for opening detail, not rendered text.
      id: r.telegramId,
      name: r.fullName,
      username: r.username,
      phone: r.phone,
      balance: r.balance,
      orderCount: r.orderCount,
      orderValue: r.orderValue,
      lastActiveAt: r.lastActiveAt ? isoToLocalDateTime(r.lastActiveAt, tz) : null,
    })),
  );
});

route("GET", "/api/admin/customers/:id", ({ app, params }) => {
  const telegramId = num(params.id);
  const summary = app.customers.customerSummary(telegramId);
  const orders = app.orders.listForCustomer(telegramId, 20).map((o) => orderDto(o, app.config.timezone));
  const deposits = app.customers.listDeposits(telegramId, 10);
  const transactions = app.customers.listTransactions(telegramId, 20);
  const ratings = app.loyalty.ratingsForCustomer(telegramId, 10);
  return json({
    ...summary,
    profile: summary.profile
      ? {
          telegramId: summary.profile.telegramId,
          fullName: summary.profile.fullName,
          phone: summary.profile.phone,
          address: summary.profile.address,
          username: summary.profile.username,
        }
      : null,
    orders,
    deposits: deposits.map((d) => ({
      amount: d.amount,
      status: d.status,
      hasReceipt: !!d.receiptFileId,
      time: isoToLocalDateTime(d.createdAt, app.config.timezone),
    })),
    transactions: transactions.map((t) => ({
      amount: t.amount,
      kindLabel: WALLET_TX_LABELS[t.kind] ?? "—",
      balanceAfter: t.balanceAfter,
      note: t.note,
      time: isoToLocalDateTime(t.createdAt, app.config.timezone),
    })),
    ratings,
  });
});

/**
 * Manual wallet adjustment (correction, promo credit, comp). The amount is a
 * signed integer; the server re-validates against balance/limit rules and the
 * admin actor is recorded in the ledger for audit.
 *
 * The customer is told about the change through the durable notification queue
 * (kind `wallet_adjustment`), keyed by the ledger transaction id so a retried
 * request can never send the same notice twice.
 */
route("POST", "/api/admin/customers/:id/wallet", async ({ app, user, params, req }) => {
  const telegramId = num(params.id);
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount === 0) {
    return badRequest("مبلغ باید عدد صحیح غیرصفر باشد");
  }
  if (Math.abs(amount) > 100_000_000) return badRequest("مبلغ بیش از حد مجاز است");
  const r = app.customers.adjustBalance(telegramId, amount, body.note ?? null, user.id);
  if (!r.ok) return badRequest(r.error);

  const currency = getCurrency(app.db);
  const text = walletAdjustmentText(amount, r.balance, currency, body.note ?? null);
  app.notifications.enqueue("wallet_adjustment", `wallet_tx_${r.txId}`, [telegramId], { text });

  return json({ ok: true, balance: r.balance, notified: true });
});

/** Customer-facing message for an admin wallet change. */
export function walletAdjustmentText(
  amount: number,
  balanceAfter: number,
  currency: string,
  note: string | null,
): string {
  const cleanNote = note ? String(note).trim().slice(0, 200) : "";
  const lines = [
    amount > 0 ? "💰 کیف پول شما افزایش یافت." : "💰 کیف پول شما کاهش یافت.",
    "",
    `${amount > 0 ? "مبلغ افزوده‌شده" : "مبلغ کسرشده"}: ${formatMoney(Math.abs(amount), currency)}`,
    `موجودی جدید: ${formatMoney(balanceAfter, currency)}`,
  ];
  if (cleanNote) lines.push(`توضیح: ${cleanNote}`);
  return lines.join("\n");
}

// order lifecycle actions (admin)

/** Enqueue a customer notice (durable queue; delivery via scheduler). */
function notifyCustomer(app: ApiApp, telegramId: number, refKey: string, text: string): void {
  app.notifications.enqueue("customer_notice", refKey, [telegramId], { text });
}

route("POST", "/api/admin/orders/:ref/confirm", ({ app, user, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return badRequest("سفارش یافت نشد");
  const r = app.orders.markConfirmed(order.id, user.id);
  if (!r.ok) return badRequest(r.error);
  // Notify only on a fresh transition (never for repeated callbacks) and only
  // when the admin toggle allows it. Delivery failure never rolls this back.
  if (!r.already && getNotificationSettings(app.db).notifyOrderConfirmed) {
    notifyCustomer(
      app,
      r.order.customerTelegramId,
      `order_confirmed_${r.order.orderNumber}`,
      `✅ سفارش ${r.order.orderNumber} تأیید شد و آماده‌سازی آن شروع شده است.`,
    );
  }
  return json({ ok: true, already: r.already, order: orderDto(r.order, app.config.timezone) });
});

route("POST", "/api/admin/orders/:ref/deliver", ({ app, user, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return badRequest("سفارش یافت نشد");
  const r = app.orders.markDelivered(order.id, user.id);
  if (!r.ok) return badRequest(r.error);
  if (!r.already && getNotificationSettings(app.db).askDeliveryRating) {
    notifyCustomer(
      app,
      r.order.customerTelegramId,
      `order_rated_${r.order.orderNumber}`,
      `🎉 سفارش ${r.order.orderNumber} تحویل داده شد. لطفاً به تجربه‌تان امتیاز دهید.`,
    );
  }
  return json({ ok: true, already: r.already, order: orderDto(r.order, app.config.timezone) });
});

/**
 * The card-to-card receipt for an order, as a Telegram file_id. The Mini App
 * cannot fetch Telegram files itself, so the panel asks the server and the
 * server hands back only the opaque id (never a bot token or file URL).
 */
route("GET", "/api/admin/orders/:ref/receipt", ({ app, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order || !order.receiptFileId) return json({ error: "رسیدی ثبت نشده است" }, 404);
  return json({ fileId: order.receiptFileId });
});

/**
 * Stream the receipt image itself. Telegram file URLs embed the bot token, so
 * they must never reach the browser — the server resolves the file_id and
 * proxies the bytes. Admin-only (the route table authenticates every request).
 */
route("GET", "/api/admin/orders/:ref/receipt/image", async ({ app, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order || !order.receiptFileId) return json({ error: "رسیدی ثبت نشده است" }, 404);
  if (!app.bot) return json({ error: "دریافت تصویر رسید در دسترس نیست" }, 503);
  try {
    const file = await app.bot.api.getFile(order.receiptFileId);
    if (!file.file_path) return json({ error: "فایل رسید یافت نشد" }, 404);
    const res = await fetch(
      `https://api.telegram.org/file/bot${app.config.botToken}/${file.file_path}`,
    );
    if (!res.ok || !res.body) return json({ error: "دریافت تصویر رسید ناموفق بود" }, 502);
    return new Response(res.body, {
      headers: {
        "content-type": res.headers.get("content-type") ?? "image/jpeg",
        "cache-control": "private, max-age=300",
      },
    });
  } catch (err) {
    log.warn("receipt image fetch failed", { order: order.orderNumber, err: String(err) });
    return json({ error: "دریافت تصویر رسید ناموفق بود" }, 502);
  }
});

/** Admin approves a card-to-card payment (receipt accepted → order paid). */
route("POST", "/api/admin/orders/:ref/payment/approve", ({ app, user, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return badRequest("سفارش یافت نشد");
  const r = app.orders.markPaymentPaid(order.id, user.id);
  if (!r.ok) return badRequest(r.error);
  if (!r.already) {
    notifyCustomer(
      app,
      r.order.customerTelegramId,
      `payment_approved_${r.order.orderNumber}`,
      `✅ پرداخت سفارش ${r.order.orderNumber} تأیید شد.`,
    );
  }
  return json({ ok: true, already: r.already, order: orderDto(r.order, app.config.timezone) });
});

/** Admin rejects a card-to-card receipt (wrong amount, unreadable, unpaid). */
route("POST", "/api/admin/orders/:ref/payment/reject", ({ app, user, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return badRequest("سفارش یافت نشد");
  const r = app.orders.markPaymentRejected(order.id, user.id);
  if (!r.ok) return badRequest(r.error);
  if (!r.already) {
    notifyCustomer(
      app,
      r.order.customerTelegramId,
      `payment_rejected_${r.order.orderNumber}`,
      `⚠️ رسید پرداخت سفارش ${r.order.orderNumber} تأیید نشد. لطفاً با کافه تماس بگیرید.`,
    );
  }
  return json({ ok: true, already: r.already, order: orderDto(r.order, app.config.timezone) });
});

/**
 * Handle an admin API request. Returns null when no admin route matched
 * (caller may then try static files or 404).
 */
export async function handleAdminApi(req: Request, app: ApiApp): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/admin/")) return null;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.rx);
    if (!m) continue;

    let user: TelegramUser;
    try {
      user = authenticate(req, app);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, err.status);
      throw err;
    }
    try {
      return await r.handler({
        app,
        user,
        req,
        url,
        params: (m.groups ?? {}) as Record<string, string>,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      log.error("admin api error", { path: url.pathname, err: String(err) });
      return json({ error: "خطای داخلی سرور" }, 500);
    }
  }
  return json({ error: "مسیر یافت نشد" }, 404);
}
