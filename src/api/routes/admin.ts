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
import {
  getMembershipSettings,
  updateMembershipSettings,
  type MembershipStatus,
} from "../../services/membership";
import { formatMoney, parseAmountInput } from "../../utils/money";
import { formatJalaliFa, isValidDate } from "../../utils/dates";
import { paymentRejectedCustomerText, receiptApprovedCaption, receiptRejectedCaption } from "../../bot/format";
import { log } from "../../utils/logger";
import type { AdminOrderUpdate, Order } from "../../services/orders";

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
 * the UI shows; the raw `status` stays for API compatibility/consumers.
 * `fulfillmentStatus` drives the lifecycle buttons (only valid transitions are
 * offered). Item product/variant ids are catalog ids — the same ids the
 * products API already exposes to admins — required for editing lines. */
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
    fulfillmentStatus: o.fulfillmentStatus,
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
      productId: it.productId,
      variantId: it.variantId,
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

/**
 * One order by its human-readable number — the detail view's data source.
 * The reports page and the customer profile both open details from a list
 * row, so both can fetch the same authoritative snapshot by order number.
 */
route("GET", "/api/admin/orders/:ref", ({ app, params }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return json({ error: "سفارش یافت نشد" }, 404);
  return json(orderDto(order, app.config.timezone));
});

/**
 * Admin edit of a placed order. Items are revalidated and repriced
 * server-side against the live menu (after-hours aware); the scheduled time,
 * fulfillment method and delivery notes are editable fields the order already
 * has. Delivered/cancelled orders are frozen; wallet-funded orders have their
 * ledger reconciled atomically inside the service transaction.
 */
route("PUT", "/api/admin/orders/:ref", async ({ app, user, params, req }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return badRequest("سفارش یافت نشد");
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("JSON نامعتبر است");
  }
  const update: AdminOrderUpdate = {};
  if ("items" in body) {
    update.items = Array.isArray(body.items)
      ? (body.items as AdminOrderUpdate["items"])
      : [];
  }
  if ("deliveryTime" in body) {
    update.deliveryTime =
      body.deliveryTime === null || body.deliveryTime === undefined
        ? null
        : String(body.deliveryTime);
  }
  if ("fulfillmentMethod" in body) {
    update.fulfillmentMethod = body.fulfillmentMethod as AdminOrderUpdate["fulfillmentMethod"];
  }
  if ("deliveryNotes" in body) {
    update.deliveryNotes =
      body.deliveryNotes === null || body.deliveryNotes === undefined
        ? null
        : String(body.deliveryNotes);
  }
  const r = app.orders.adminUpdateOrder(order.id, user.id, update);
  if (!r.ok) return badRequest(r.error);
  return json({ ok: true, order: orderDto(r.order, app.config.timezone) });
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
        notifyWalletChanges:
          body.notifyWalletChanges !== undefined ? !!body.notifyWalletChanges : undefined,
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
  const balance = deposit ? app.customers.getBalance(deposit.telegramId) : 0;

  // Tell the customer the top-up landed — gated by the admin's notification
  // switch. The ref key is the ledger transaction id, so a retried approve
  // (or a double-click) can never queue the same notice twice.
  let notified = false;
  if (deposit && getNotificationSettings(app.db).notifyWalletChanges) {
    const currency = getCurrency(app.db);
    const text = walletDepositApprovedText(r.deposit.amount, r.balanceAfter, currency);
    notified = app.notifications.enqueue("wallet_adjustment", `wallet_tx_${r.txId}`, [r.deposit.telegramId], { text }) > 0;
  }

  return json({ ok: true, balance, notified });
});

route("POST", "/api/admin/wallet/deposits/:id/reject", ({ app, user, params }) => {
  const r = app.customers.rejectDeposit(num(params.id), user.id);
  if (!r.ok) return badRequest(r.error);
  return json({ ok: true });
});

// customer list + detail (admin)

/** Persian labels for channel-membership status (never raw codes in the UI). */
const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  member: "عضو کانال",
  not_member: "عضو نیست",
  unknown: "بررسی ناموفق",
};

/**
 * Customer directory for the panel: profile, wallet balance, order stats,
 * and the last known channel-membership result (cached — never a live
 * Telegram call per row). Telegram ids are values here, not display labels.
 *
 * `membership` query filter: member | not_member | unknown | none
 * (none = never verified). Filtering happens in SQL over the cached table so
 * the page stays fast.
 */
route("GET", "/api/admin/customers", ({ app, url }) => {
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const membershipFilter = (url.searchParams.get("membership") ?? "").trim();
  if (membershipFilter && !["member", "not_member", "unknown", "none"].includes(membershipFilter)) {
    return badRequest("فیلتر عضویت نامعتبر است");
  }
  const rows = app.customers.listCustomerRows(limit);
  const tz = app.config.timezone;
  // Resolve a possible referral code once (normalized; null for non-codes).
  const qReferralOwner = q ? app.referrals.lookup(q) : null;
  const filtered = q
    ? rows.filter((r) => {
        const name = r.fullName ?? "";
        return (
          name.includes(q) ||
          (r.phone ?? "").includes(q) ||
          (r.username ?? "").toLowerCase().includes(q.toLowerCase()) ||
          qReferralOwner === r.telegramId
        );
      })
    : rows;
  const withMembership = filtered.map((r) => {
    const record = app.membership.recordFor(r.telegramId);
    return {
      // The id is the route parameter for opening detail, not rendered text.
      id: r.telegramId,
      name: r.fullName,
      username: r.username,
      phone: r.phone,
      balance: r.balance,
      orderCount: r.orderCount,
      orderValue: r.orderValue,
      lastActiveAt: r.lastActiveAt ? isoToLocalDateTime(r.lastActiveAt, tz) : null,
      membership: record
        ? {
            status: record.status,
            statusLabel: MEMBERSHIP_STATUS_LABELS[record.status] ?? "—",
            channel: record.channel,
            checkedAt: isoToLocalDateTime(record.checkedAt, tz),
          }
        : null,
    };
  });
  const membershipFiltered = membershipFilter
    ? withMembership.filter((r) => {
        if (membershipFilter === "none") return r.membership === null;
        return r.membership?.status === membershipFilter;
      })
    : withMembership;
  return json(membershipFiltered);
});

route("GET", "/api/admin/customers/:id", ({ app, params }) => {
  const telegramId = num(params.id);
  const summary = app.customers.customerSummary(telegramId);
  const orders = app.orders.listForCustomer(telegramId, 20).map((o) => orderDto(o, app.config.timezone));
  const deposits = app.customers.listDeposits(telegramId, 10);
  const transactions = app.customers.listTransactions(telegramId, 20);
  const ratings = app.loyalty.ratingsForCustomer(telegramId, 10);
  const membershipSettings = getMembershipSettings(app.db);
  const membershipRecord = app.membership.recordFor(telegramId);
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
    membership: {
      configuredChannel: membershipSettings.channel,
      enforcementEnabled: membershipSettings.enabled,
      status: membershipRecord?.status ?? null,
      statusLabel: membershipRecord
        ? (MEMBERSHIP_STATUS_LABELS[membershipRecord.status] ?? "—")
        : "هنوز بررسی نشده",
      channel: membershipRecord?.channel ?? null,
      checkedAt: membershipRecord
        ? isoToLocalDateTime(membershipRecord.checkedAt, app.config.timezone)
        : null,
    },
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
 * Referral tab data for the customer profile: the customer's own code/link,
 * their current referrer (if any), direct referred customers (paginated),
 * and a short audit history. The code always comes from the database.
 */
route("GET", "/api/admin/customers/:id/referral", ({ app, params, url }) => {
  const telegramId = num(params.id);
  const code = app.referrals.ensureCode(telegramId);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));

  const relation = app.referrals.getReferrer(telegramId);
  const referrer = relation
    ? (() => {
        const p = app.customers.getProfile(relation.referredBy);
        return {
          id: relation.referredBy,
          name: p?.fullName?.trim() || "بدون نام",
          username: p?.username ?? null,
          phone: p?.phone ?? null,
          referralCode: app.referrals.getCode(relation.referredBy),
          source: relation.source,
          createdAt: relation.createdAt,
        };
      })()
    : null;

  const referred = app.referrals.listReferred(telegramId, limit, offset).map((r) => ({
    id: r.telegramId,
    name: r.fullName || "بدون نام",
    username: r.username,
    referralCode: r.referralCode,
    createdAt: r.createdAt,
  }));

  const botUsername = getSetting(app.db, "bot_username").trim() || null;
  return json({
    code,
    link: botUsername ? `https://t.me/${botUsername}?start=ref_${code}` : null,
    referredCount: app.referrals.countReferred(telegramId),
    referrer,
    referred,
    offset,
    limit,
    history: app.referrals.history(telegramId, 10).map((e) => ({
      action: e.action,
      actor: e.actor,
      previousReferredBy: e.previousReferredBy,
      newReferredBy: e.newReferredBy,
      createdAt: e.createdAt,
    })),
  });
});

/** Admin: assign or change this customer's referrer (validated server-side). */
route("POST", "/api/admin/customers/:id/referrer", async ({ app, user, params, req }) => {
  const telegramId = num(params.id);
  const body = (await req.json().catch(() => null)) as { referrerId?: unknown } | null;
  const referrerId = Number(body?.referrerId);
  if (!Number.isInteger(referrerId) || referrerId <= 0) {
    return badRequest("شناسه معرف نامعتبر است");
  }
  const r = app.referrals.setReferrerByAdmin(telegramId, referrerId, user.id);
  if (!r.ok) return badRequest(r.error);
  return json({
    ok: true,
    referrer: {
      id: r.relation.referredBy,
      name: app.customers.getProfile(r.relation.referredBy)?.fullName?.trim() || "بدون نام",
      referralCode: r.relation.referralCodeUsed,
      createdAt: r.relation.createdAt,
    },
  });
});

/** Admin: remove this customer's referrer (customer data is never deleted). */
route("DELETE", "/api/admin/customers/:id/referrer", ({ app, user, params }) => {
  const telegramId = num(params.id);
  const r = app.referrals.removeReferrer(telegramId, user.id);
  if (!r.ok) return badRequest(r.error);
  return json({ ok: true });
});

/**
 * Unified transaction history for the customer profile: wallet ledger entries
 * merged with card-to-card order payments, newest first.
 * Filters: `type` = all | wallet_in | wallet_out | card; `from`/`to` = YYYY-MM-DD.
 */
route("GET", "/api/admin/customers/:id/transactions", ({ app, params, url }) => {
  const telegramId = num(params.id);
  const type = (url.searchParams.get("type") ?? "all").trim();
  if (!["all", "wallet_in", "wallet_out", "card"].includes(type)) {
    return badRequest("نوع تراکنش نامعتبر است");
  }
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
    return badRequest("بازه زمانی نامعتبر است");
  }

  const tz = app.config.timezone;
  const items: any[] = [];

  if (type !== "card") {
    let sql = "SELECT * FROM wallet_transactions WHERE telegram_id = ?";
    const args: any[] = [telegramId];
    if (type === "wallet_in") sql += " AND amount > 0";
    if (type === "wallet_out") sql += " AND amount < 0";
    if (from) { sql += " AND substr(created_at, 1, 10) >= ?"; args.push(from); }
    if (to) { sql += " AND substr(created_at, 1, 10) <= ?"; args.push(to); }
    sql += " ORDER BY id DESC LIMIT 200";
    const rows = app.db.query(sql).all(...args) as any[];
    // Resolve order numbers for order-linked ledger entries (one query).
    const orderIds = rows.filter((r) => r.ref_type === "order").map((r) => r.ref_id);
    const orderNums = new Map<number, string>();
    if (orderIds.length) {
      const orows = app.db
        .query(`SELECT id, order_number FROM orders WHERE id IN (${orderIds.map(() => "?").join(",")})`)
        .all(...orderIds) as { id: number; order_number: string }[];
      for (const o of orows) orderNums.set(o.id, o.order_number);
    }
    for (const r of rows) {
      items.push({
        id: `w${r.id}`,
        source: "wallet",
        kind: r.kind,
        kindLabel: WALLET_TX_LABELS[r.kind] ?? "—",
        amount: r.amount,
        time: isoToLocalDateTime(r.created_at, tz),
        note: r.note ?? null,
        balanceAfter: r.balance_after,
        orderNumber: r.ref_type === "order" ? orderNums.get(r.ref_id) ?? null : null,
        paymentStatusLabel: null,
        fulfillmentLabel: null,
      });
    }
  }

  if (type !== "wallet_in" && type !== "wallet_out") {
    let sql = "SELECT * FROM orders WHERE customer_telegram_id = ? AND payment_method = 'card_to_card'";
    const args: any[] = [telegramId];
    if (from) { sql += " AND substr(created_at, 1, 10) >= ?"; args.push(from); }
    if (to) { sql += " AND substr(created_at, 1, 10) <= ?"; args.push(to); }
    sql += " ORDER BY id DESC LIMIT 200";
    const rows = app.db.query(sql).all(...args) as any[];
    for (const r of rows) {
      items.push({
        id: `o${r.id}`,
        source: "card",
        kind: "card_payment",
        kindLabel: "پرداخت کارت به کارت",
        amount: -r.total_amount,
        time: isoToLocalDateTime(r.created_at, tz),
        note: r.delivery_notes ?? null,
        balanceAfter: null,
        orderNumber: r.order_number,
        paymentStatusLabel: PAYMENT_STATUS_LABELS[r.payment_status] ?? "—",
        fulfillmentLabel: FULFILLMENT_LABELS[r.fulfillment_status] ?? "—",
      });
    }
  }

  items.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return json(items.slice(0, 300));
});

/**
 * Admin-requested fresh membership verification for one customer. Uses the
 * stored Telegram id (never a client-supplied id — the id comes from the
 * authenticated route param). Bypasses the short-lived cache. Telegram
 * failures come back as `unknown`, never as `not_member`.
 */
route("POST", "/api/admin/customers/:id/membership-check", async ({ app, params }) => {
  const telegramId = num(params.id);
  const settings = getMembershipSettings(app.db);
  if (!settings.channel) {
    return badRequest("ابتدا کانال را در تنظیمات عضویت کانال پیکربندی کنید");
  }
  const result = await app.membership.check(telegramId, { fresh: true });
  const record = app.membership.recordFor(telegramId);
  return json({
    ok: true,
    status: result.status,
    statusLabel: MEMBERSHIP_STATUS_LABELS[result.status] ?? "—",
    channel: record?.channel ?? settings.channel,
    checkedAt: record ? isoToLocalDateTime(record.checkedAt, app.config.timezone) : null,
  });
});

// channel membership settings (admin)

route("GET", "/api/admin/settings/channel-membership", ({ app }) => {
  const s = getMembershipSettings(app.db);
  return json({
    enabled: s.enabled,
    channel: s.channel ?? "",
    channelUrl: s.channelUrl,
    message: s.message,
    messageIsDefault: s.messageIsDefault,
  });
});

route("PUT", "/api/admin/settings/channel-membership", async ({ app, req }) => {
  const body = await readJson(req);
  if (!body) return badRequest("JSON نامعتبر است");
  try {
    const saved = updateMembershipSettings(app.db, {
      enabled: body.enabled !== undefined ? !!body.enabled : undefined,
      channel: body.channel !== undefined ? String(body.channel ?? "") : undefined,
      message: body.message !== undefined ? String(body.message ?? "") : undefined,
    });
    return json({
      enabled: saved.enabled,
      channel: saved.channel ?? "",
      channelUrl: saved.channelUrl,
      message: saved.message,
      messageIsDefault: saved.messageIsDefault,
    });
  } catch (err) {
    return badRequest(String(err instanceof Error ? err.message : err));
  }
});

/**
 * Manual wallet adjustment (correction, promo credit, comp). The amount is a
 * signed integer; the server re-validates against balance/limit rules and the
 * admin actor is recorded in the ledger for audit.
 *
 * When the admin's wallet-notification switch is on, the customer is told about
 * the change through the durable notification queue (kind `wallet_adjustment`),
 * keyed by the ledger transaction id so a retried request can never send the
 * same notice twice. With the switch off, `notified` comes back false.
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

  let notified = false;
  if (getNotificationSettings(app.db).notifyWalletChanges) {
    const currency = getCurrency(app.db);
    const text = walletAdjustmentText(amount, r.balance, currency, body.note ?? null);
    notified = app.notifications.enqueue("wallet_adjustment", `wallet_tx_${r.txId}`, [telegramId], { text }) > 0;
  }

  return json({ ok: true, balance: r.balance, notified });
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

/** Customer-facing message after an admin approves a card-to-card top-up. */
export function walletDepositApprovedText(amount: number, balanceAfter: number, currency: string): string {
  return [
    "✅ درخواست شارژ کیف پول شما تأیید شد.",
    "",
    `مبلغ شارژ: ${formatMoney(amount, currency)}`,
    `موجودی جدید: ${formatMoney(balanceAfter, currency)}`,
  ].join("\n");
}

// order lifecycle actions (admin)

/** Enqueue a customer notice (durable queue; delivery via scheduler). */
function notifyCustomer(
  app: ApiApp,
  telegramId: number,
  refKey: string,
  text: string,
  photoFileId?: string | null,
): void {
  app.notifications.enqueue("customer_notice", refKey, [telegramId], {
    text,
    ...(photoFileId ? { photoFileId } : {}),
  });
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

/**
 * Best-effort sync of the delivered Telegram receipt notices after a review
 * decision made from the panel. The bot keyboard path edits the message it was
 * pressed on directly; this covers the same decision arriving through the API
 * so the caption, the keyboard, and the database stay consistent. Failures
 * never affect the response — the database is the source of truth.
 */
async function syncReceiptNotices(app: ApiApp, orderNumber: string, caption: string): Promise<void> {
  if (!app.bot) return;
  const rows = app.db
    .query(
      `SELECT recipient_id, notification_id FROM notifications
       WHERE kind = 'order_update' AND ref_key = ? AND notification_id IS NOT NULL`,
    )
    .all(orderNumber) as { recipient_id: number; notification_id: number }[];
  for (const row of rows) {
    try {
      await app.bot.api.editMessageCaption(row.recipient_id, row.notification_id, {
        caption,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      log.warn("receipt notice caption edit failed", { orderNumber, err: String(err) });
    }
  }
}

/** Admin approves a card-to-card payment (receipt accepted → order paid). */
route("POST", "/api/admin/orders/:ref/payment/approve", async ({ app, user, params }) => {
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
  // Re-sync even when `already` so a previously failed caption edit self-heals;
  // rewriting an identical caption is harmless on Telegram's side.
  await syncReceiptNotices(app, r.order.orderNumber, receiptApprovedCaption(r.order.orderNumber));
  return json({ ok: true, already: r.already, order: orderDto(r.order, app.config.timezone) });
});

/**
 * Admin rejects a card-to-card receipt. The panel collects an optional reason
 * (`{ reason }`); without one the customer still gets the receipt image with a
 * generic text. The bot keyboard path always requires a reason.
 */
route("POST", "/api/admin/orders/:ref/payment/reject", async ({ app, user, params, req }) => {
  const order = app.orders.findByNumber(decodeURIComponent(params.ref));
  if (!order) return badRequest("سفارش یافت نشد");
  let reason: string | null = null;
  try {
    const body = (await readJson(req)) as { reason?: unknown } | null;
    if (typeof body?.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 500);
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) throw err;
    // Unreadable body: fall through with no reason (backward compatible).
  }
  const r = app.orders.markPaymentRejected(order.id, user.id, reason);
  if (!r.ok) return badRequest(r.error);
  if (!r.already) {
    const text = reason
      ? paymentRejectedCustomerText(r.order.orderNumber, reason)
      : `⚠️ رسید پرداخت سفارش ${r.order.orderNumber} تأیید نشد. لطفاً با کافه تماس بگیرید.`;
    notifyCustomer(
      app,
      r.order.customerTelegramId,
      `payment_rejected_${r.order.orderNumber}`,
      text,
      r.order.receiptFileId,
    );
  }
  await syncReceiptNotices(app, r.order.orderNumber, receiptRejectedCaption(r.order.orderNumber));
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
