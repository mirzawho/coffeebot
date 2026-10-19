import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { ReferralService, normalizeCode, parseStartParam, referralDeepLink } from "../src/services/referrals";
import { CustomersService } from "../src/services/customers";
import { CartService } from "../src/services/cart";
import { MenuService } from "../src/services/menu";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { updatePaymentSettings } from "../src/services/settings";
import { mainMenu } from "../src/bot/keyboards";
import { menuFor } from "../src/bot/handlers/messages";
import { handleAdminApi } from "../src/api/routes/admin";
import { signInitData } from "../src/api/middleware/auth";
import { loadConfig } from "../src/config";
import { ReportService } from "../src/services/reports";
import { NotificationService } from "../src/services/notifications";
import { ChannelMembershipService } from "../src/services/membership";
import { LoyaltyService } from "../src/services/loyalty";

let db: Db;
let referrals: ReferralService;
let customers: CustomersService;

beforeEach(() => {
  db = openDatabase(":memory:");
  referrals = new ReferralService(db);
  customers = new CustomersService(db);
});

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

describe("referral codes", () => {
  test("existing customers receive stable codes via backfill", () => {
    customers.saveProfile(100, { fullName: "مشتری قدیمی" });
    customers.saveProfile(200, { fullName: "مشتری دیگر" });
    // A second service instance over the same DB backfills missing codes.
    const r2 = new ReferralService(db);
    const a = r2.getCode(100);
    const b = r2.getCode(200);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // Stable: reconstructing does not regenerate.
    const r3 = new ReferralService(db);
    expect(r3.getCode(100)).toBe(a);
    expect(referrals.getCode(100)).toBe(a);
  });

  test("new customers get a code on demand and it persists", () => {
    const code = referrals.ensureCode(555);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(referrals.ensureCode(555)).toBe(code);
    expect(referrals.getCode(555)).toBe(code);
  });

  test("codes are unique across many customers", () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 200; i++) {
      const c = referrals.ensureCode(1000 + i);
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
  });

  test("normalizeCode is case-insensitive and rejects malformed input", () => {
    const code = referrals.ensureCode(555);
    expect(normalizeCode(code.toLowerCase())).toBe(code);
    expect(normalizeCode(` ${code} `)).toBe(code);
    expect(normalizeCode(`ref_${code}`)).toBe(code);
    expect(normalizeCode("۱")).toBeNull(); // Persian digits not in alphabet
    expect(normalizeCode("SHORT")).toBeNull();
    expect(normalizeCode("".padEnd(8, "0"))).toBeNull(); // 0 not in alphabet
    expect(normalizeCode(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Attribution (manual entry + deep link — same rules)
// ---------------------------------------------------------------------------

describe("referral attribution", () => {
  beforeEach(() => {
    customers.saveProfile(1, { fullName: "معرف" });
    customers.saveProfile(2, { fullName: "مشتری" });
    referrals.ensureCode(1);
    referrals.ensureCode(2);
  });

  test("valid manual code creates a relationship", () => {
    const code = referrals.getCode(1)!;
    const r = referrals.applyReferral(2, code, "manual");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation.referredBy).toBe(1);
    expect(r.relation.source).toBe("manual");
    expect(referrals.getReferrer(2)?.referredBy).toBe(1);
    expect(referrals.countReferred(1)).toBe(1);
  });

  test("manual entry and deep-link registration use the same validation", () => {
    const code = referrals.getCode(1)!;
    // Deep link with a lowercase/padded variant still normalizes.
    const r = referrals.applyReferral(2, `ref_${code.toLowerCase()}`, "link");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation.referredBy).toBe(1);
    expect(r.relation.source).toBe("link");
  });

  test("invalid codes are rejected and create nothing", () => {
    expect(referrals.applyReferral(2, "NOTREAL1", "manual").ok).toBe(false);
    expect(referrals.applyReferral(2, "", "manual").ok).toBe(false);
    expect(referrals.applyReferral(2, "short", "manual").ok).toBe(false);
    expect(referrals.getReferrer(2)).toBeNull();
    expect(referrals.countReferred(1)).toBe(0);
  });

  test("self-referrals are rejected", () => {
    const own = referrals.getCode(2)!;
    const r = referrals.applyReferral(2, own, "manual");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("self_referral");
    expect(referrals.getReferrer(2)).toBeNull();
  });

  test("a customer cannot register multiple referrers; repeated /start does not overwrite", () => {
    customers.saveProfile(3, { fullName: "معرف دوم" });
    referrals.ensureCode(3);
    const first = referrals.applyReferral(2, referrals.getCode(1)!, "manual");
    expect(first.ok).toBe(true);
    // A second, different code is refused.
    const second = referrals.applyReferral(2, referrals.getCode(3)!, "manual");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_registered");
    // Repeated /start with the ORIGINAL code is also refused (no duplicates).
    const again = referrals.applyReferral(2, referrals.getCode(1)!, "link");
    expect(again.ok).toBe(false);
    expect(referrals.getReferrer(2)?.referredBy).toBe(1);
    expect(referrals.countReferred(1)).toBe(1);
    expect(referrals.countReferred(3)).toBe(0);
  });

  test("deep-link params are parsed correctly", () => {
    const code = referrals.getCode(1)!;
    expect(parseStartParam(`ref_${code}`)).toBe(code);
    expect(parseStartParam(`ref_${code.toLowerCase()}`)).toBe(code);
    expect(parseStartParam("REF_" + code)).toBe(code);
    expect(parseStartParam("help")).toBeNull();
    expect(parseStartParam("ref_BAD")).toBeNull();
    expect(parseStartParam("")).toBeNull();
    expect(parseStartParam(undefined)).toBeNull();
  });

  test("referral deep link uses the real bot username", () => {
    const link = referralDeepLink("MyCafeBot", "ABCD2345");
    expect(link).toBe("https://t.me/MyCafeBot?start=ref_ABCD2345");
    expect(referralDeepLink("", "ABCD2345")).toBeNull();
    expect(referralDeepLink("@MyCafeBot", "ABCD2345")).toBe("https://t.me/MyCafeBot?start=ref_ABCD2345");
  });

  test("brand-new customer (no profile row) gets a record and then the relationship", () => {
    expect(customers.getProfile(9)).toBeNull();
    const r = referrals.applyReferral(9, referrals.getCode(1)!, "link");
    expect(r.ok).toBe(true);
    expect(customers.getProfile(9)).not.toBeNull(); // created before the FK insert
    expect(referrals.getReferrer(9)?.referredBy).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Menu keyboard (persisted status)
// ---------------------------------------------------------------------------

describe("referral menu entry", () => {
  function buttons(kb: any): string[] {
    return (kb.inline_keyboard as any[][]).flat().map((b: any) => b.callback_data ?? b.url ?? "");
  }

  test("entry button is present when the customer has no referrer", () => {
    const data = buttons(mainMenu(0, null, true));
    expect(data).toContain("refcode");
    expect(data).toContain("ref");
  });

  test("entry button is hidden after successful attribution", () => {
    customers.saveProfile(1, { fullName: "م" });
    customers.saveProfile(2, { fullName: "ش" });
    referrals.ensureCode(1);
    referrals.applyReferral(2, referrals.getCode(1)!, "manual");
    const data = buttons(mainMenu(0, null, false));
    expect(data).not.toContain("refcode");
    // The sharing section remains reachable.
    expect(data).toContain("ref");
  });

  test("menuFor builds from persisted referral status", () => {
    customers.saveProfile(2, { fullName: "ش" });
    const app: any = {
      cart: { lineCount: () => 0 },
      referrals,
    };
    expect(buttons(menuFor(app, 2))).toContain("refcode");
    customers.saveProfile(1, { fullName: "م" });
    referrals.ensureCode(1);
    referrals.applyReferral(2, referrals.getCode(1)!, "manual");
    expect(buttons(menuFor(app, 2))).not.toContain("refcode");
  });
});

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

describe("admin referral management", () => {
  beforeEach(() => {
    customers.saveProfile(1, { fullName: "معرف" });
    customers.saveProfile(2, { fullName: "مشتری" });
    customers.saveProfile(3, { fullName: "معرف دوم" });
    referrals.ensureCode(1);
    referrals.ensureCode(2);
    referrals.ensureCode(3);
    referrals.applyReferral(2, referrals.getCode(1)!, "manual");
  });

  test("listReferred returns direct referrals with identity info", () => {
    referrals.applyReferral(3, referrals.getCode(1)!, "link");
    const list = referrals.listReferred(1);
    expect(list.length).toBe(2);
    const ids = list.map((r) => r.telegramId).sort();
    expect(ids).toEqual([2, 3]);
    expect(list.find((r) => r.telegramId === 2)?.fullName).toBe("مشتری");
  });

  test("admin can assign and change a referrer without touching the customer's own code", () => {
    const ownCode = referrals.getCode(2)!;
    const r = referrals.setReferrerByAdmin(2, 3, 777);
    expect(r.ok).toBe(true);
    expect(referrals.getReferrer(2)?.referredBy).toBe(3);
    expect(referrals.getCode(2)).toBe(ownCode); // unchanged
    expect(referrals.countReferred(1)).toBe(0);
    expect(referrals.countReferred(3)).toBe(1);
    // Audit trail records the change with the admin actor.
    const history = referrals.history(2);
    expect(history.some((e) => e.action === "change" && e.actor === 777 && e.previousReferredBy === 1 && e.newReferredBy === 3)).toBe(true);
  });

  test("admin cannot create a self-referral", () => {
    const r = referrals.setReferrerByAdmin(2, 2, 777);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("self_referral");
    expect(referrals.getReferrer(2)?.referredBy).toBe(1);
  });

  test("admin assignment to unknown customers is rejected", () => {
    expect(referrals.setReferrerByAdmin(999, 1, 777).ok).toBe(false);
    expect(referrals.setReferrerByAdmin(2, 999, 777).ok).toBe(false);
  });

  test("admin can remove a referrer; codes and unrelated data survive; customer becomes eligible again", () => {
    // Give the customer an order + wallet activity to prove nothing else is touched.
    updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
    const menu = new MenuService(db);
    const bh = new BusinessHoursService(db, "Asia/Tehran");
    const cart = new CartService(db);
    const orders = new OrdersService(db, bh);
    const cat = menu.createCategory({ name: "نوشیدنی" });
    const water = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 10000 }).id;
    cart.addItem(2, water, null, 1);
    orders.startCheckout(2);
    orders.attachReceipt(2, "f", 1);
    cart.setFulfillmentMethod(2, "pickup");
    const conf = orders.confirmOrder(2, "مشتری");
    expect(conf.ok).toBe(true);
    customers.adjustBalance(2, 5000, "شارژ", 777);

    const ownCode = referrals.getCode(2)!;
    const r = referrals.removeReferrer(2, 777);
    expect(r.ok).toBe(true);
    expect(referrals.getReferrer(2)).toBeNull();
    // Own code preserved; referrer's code and other referrals intact.
    expect(referrals.getCode(2)).toBe(ownCode);
    expect(referrals.getCode(1)).toBeTruthy();
    // Unrelated data untouched.
    expect(orders.listForCustomer(2).length).toBe(1);
    expect(customers.getBalance(2)).toBe(5000);
    // Audit trail keeps the removal.
    expect(referrals.history(2).some((e) => e.action === "remove" && e.actor === 777)).toBe(true);
    // Eligible again.
    const re = referrals.applyReferral(2, referrals.getCode(3)!, "manual");
    expect(re.ok).toBe(true);
    // Removing when none exists is refused.
    customers.saveProfile(8, { fullName: "بی‌معرف" });
    expect(referrals.removeReferrer(8, 777).ok).toBe(false);
  });

  test("referral counts track attribution, change, and removal", () => {
    expect(referrals.countReferred(1)).toBe(1);
    referrals.setReferrerByAdmin(2, 3, 777);
    expect(referrals.countReferred(1)).toBe(0);
    expect(referrals.countReferred(3)).toBe(1);
    referrals.removeReferrer(2, 777);
    expect(referrals.countReferred(3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Admin API authorization + endpoints
// ---------------------------------------------------------------------------

describe("admin referral API", () => {
  let apiApp: any;
  const ADMIN = { id: 777, first_name: "Admin" };
  const NOW_S = () => Math.floor(Date.now() / 1000);

  function headers(initData = true): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (initData) h["x-telegram-init-data"] = signInitData("123456:TEST-ADM-TOKEN", ADMIN as any, NOW_S());
    return h;
  }

  async function call(method: string, path: string, body?: unknown, auth = true) {
    return handleAdminApi(
      new Request(`http://localhost${path}`, {
        method,
        headers: headers(auth),
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
    const businessHours = new BusinessHoursService(db, "Asia/Tehran");
    apiApp = {
      config,
      db,
      menu: new MenuService(db),
      orders: new OrdersService(db, businessHours),
      businessHours,
      reports: new ReportService(db, businessHours, new NotificationService(db), "Asia/Tehran"),
      notifications: new NotificationService(db),
      uploadsDir: "/tmp/cafe-uploads-test",
      customers,
      loyalty: new LoyaltyService(db),
      membership: new ChannelMembershipService(db),
      referrals,
    };
    customers.saveProfile(1, { fullName: "معرف" });
    customers.saveProfile(2, { fullName: "مشتری" });
    referrals.ensureCode(1);
    referrals.ensureCode(2);
    referrals.applyReferral(2, referrals.getCode(1)!, "manual");
  });

  test("referral tab endpoint returns code, referrer, and referred list", async () => {
    const r = await call("GET", "/api/admin/customers/2/referral");
    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(b.code).toBe(referrals.getCode(2));
    expect(b.referrer.id).toBe(1);
    expect(b.referrer.name).toBe("معرف");
    expect(b.referredCount).toBe(0);
    expect(b.referrer.source).toBe("manual");

    const up = await call("GET", "/api/admin/customers/1/referral");
    expect((up.body as any).referredCount).toBe(1);
    expect((up.body as any).referred[0].id).toBe(2);
  });

  test("admin can change and remove a referrer via the API", async () => {
    customers.saveProfile(3, { fullName: "معرف دوم" });
    referrals.ensureCode(3);
    const change = await call("POST", "/api/admin/customers/2/referrer", { referrerId: 3 });
    expect(change.status).toBe(200);
    expect((change.body as any).referrer.id).toBe(3);

    const del = await call("DELETE", "/api/admin/customers/2/referrer");
    expect(del.status).toBe(200);
    const after = await call("GET", "/api/admin/customers/2/referral");
    expect((after.body as any).referrer).toBeNull();
  });

  test("invalid admin assignments are rejected", async () => {
    const self = await call("POST", "/api/admin/customers/2/referrer", { referrerId: 2 });
    expect(self.status).toBe(400);
    const unknown = await call("POST", "/api/admin/customers/2/referrer", { referrerId: 999 });
    expect(unknown.status).toBe(400);
    const malformed = await call("POST", "/api/admin/customers/2/referrer", {});
    expect(malformed.status).toBe(400);
    expect(referrals.getReferrer(2)?.referredBy).toBe(1); // unchanged
  });

  test("unauthorized users cannot read or change referral relationships", async () => {
    const noAuth = await call("GET", "/api/admin/customers/2/referral", undefined, false);
    expect(noAuth.status).toBeGreaterThanOrEqual(401);
    const change = await call("POST", "/api/admin/customers/2/referrer", { referrerId: 1 }, false);
    expect(change.status).toBeGreaterThanOrEqual(401);
    const del = await call("DELETE", "/api/admin/customers/2/referrer", undefined, false);
    expect(del.status).toBeGreaterThanOrEqual(401);
    expect(referrals.getReferrer(2)?.referredBy).toBe(1);
  });

  test("customer search finds customers by referral code", async () => {
    const code = referrals.getCode(1)!;
    const r = await call("GET", `/api/admin/customers?q=${code}`);
    expect(r.status).toBe(200);
    expect((r.body as any[]).map((c: any) => c.id)).toContain(1);
  });
});
