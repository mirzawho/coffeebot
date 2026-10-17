import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";
import { formatOrderNumber } from "../utils/ids";
import { formatMoney } from "../utils/money";
import { BusinessHoursService } from "./business-hours";
import { CartService, type CartLine, type FulfillmentMethod } from "./cart";
import { MenuService } from "./menu";
import { CustomersService } from "./customers";
import { cardToCardAvailable, getCurrency, getPaymentSettings, type PaymentSettings } from "./settings";

export type FulfillmentStatus = "pending" | "confirmed" | "delivered" | "cancelled";
export type PaymentMethod = "card_to_card" | "wallet";
export type PaymentStatus = "unverified" | "receipt_received" | "paid" | "rejected";

export interface OrderItem {
  id: number;
  productId: number | null;
  variantId: number | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  id: number;
  orderNumber: string;
  customerTelegramId: number;
  customerName: string | null;
  businessDate: string;
  totalAmount: number;
  currency: string;
  receiptFileId: string | null;
  deliveryNotes: string | null;
  fulfillmentMethod: FulfillmentMethod;
  deliveryTime: string | null;
  status: string;
  fulfillmentStatus: FulfillmentStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  confirmedBy: number | null;
  confirmedAt: string | null;
  deliveredAt: string | null;
  paymentReviewedBy: number | null;
  paymentReviewedAt: string | null;
  /** Admin's explanation when the receipt was rejected; null until rejected. */
  rejectionReason: string | null;
  createdAt: string;
  items: OrderItem[];
}

export type ConfirmResult =
  | { ok: true; order: Order }
  | { ok: false; reason: "price_changed"; total: number; lines: CartLine[] }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "inactive_items"; error: string }
  | { ok: false; reason: "error"; error: string };

export type PlaceResult =
  | { ok: true; order: Order }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "inactive_items"; error: string }
  | { ok: false; reason: "price_changed"; total: number; lines: CartLine[] }
  | { ok: false; reason: "error"; error: string };

/**
 * How long a placed-but-pending order stays editable by the customer
 * (delivery method / time). After this window only the admin can touch it.
 */
export const ORDER_EDIT_WINDOW_MS = 15 * 60_000;

export type StartCheckoutResult =
  | { ok: true; lines: CartLine[]; total: number; payment: PaymentSettings; walletBalance: number }
  | { ok: false; reason: "empty" | "invalid_items" | "payment_unconfigured"; error: string };

export type ChoosePaymentResult =
  | { ok: true; method: PaymentMethod; total: number; balance: number }
  | { ok: false; error: string };

export class OrdersService {
  private menu: MenuService;
  private carts: CartService;
  private customers: CustomersService;

  constructor(
    private readonly db: Db,
    private readonly businessHours: BusinessHoursService,
  ) {
    this.menu = new MenuService(db);
    this.carts = new CartService(db);
    this.customers = new CustomersService(db);
  }

  /**
   * Live cart totals + payment settings for display. The after-hours rule is
   * applied here too, so a total shown to the customer always matches the
   * amount that will actually be charged at confirm time.
   */
  getPaymentInstructions(telegramId: number): {
    payment: PaymentSettings;
    total: number;
    lines: CartLine[];
  } {
    const afterHours = !this.businessHours.isOpenAt(new Date());
    const totals = this.carts.getTotals(telegramId, afterHours);
    return {
      payment: getPaymentSettings(this.db),
      total: totals.total,
      lines: totals.lines,
    };
  }

  /** Begin checkout: revalidate cart and snapshot the expected total. */
  startCheckout(telegramId: number): StartCheckoutResult {
    this.carts.pruneInvalidItems(telegramId);
    const afterHours = !this.businessHours.isOpenAt(new Date());
    const totals = this.carts.getTotals(telegramId, afterHours);
    if (totals.lines.length === 0) {
      return { ok: false, reason: "empty", error: "سبد خرید شما خالی است" };
    }
    // Every cart item must still resolve to an active product/variant with a price.
    for (const line of totals.lines) {
      const resolved = this.menu.resolvePrice(line.productId, line.variantId);
      if (!resolved.ok) return { ok: false, reason: "invalid_items", error: resolved.error };
    }
    // At least one payment route must be usable, otherwise the customer would
    // be led through a fake payment flow — refuse before entering any state.
    const payment = getPaymentSettings(this.db);
    const walletBalance = this.customers.getBalance(telegramId);
    const walletUsable = payment.walletEnabled && walletBalance > 0;
    if (!cardToCardAvailable(payment) && !walletUsable) {
      return {
        ok: false,
        reason: "payment_unconfigured",
        error:
          "پرداخت هنوز راه‌اندازی نشده است؛ لطفاً بعداً دوباره تلاش کنید یا برای هماهنگی با کافه تماس بگیرید.",
      };
    }
    this.carts.setCheckoutTotal(telegramId, totals.total);
    this.carts.setState(telegramId, "checkout_payment");
    return {
      ok: true,
      lines: totals.lines,
      total: totals.total,
      payment,
      walletBalance,
    };
  }

  /**
   * Record the customer's payment choice. Wallet is charged later, at confirm
   * time (inside the order transaction); card-to-card moves on to the receipt
   * step. The total is revalidated so a stale choice cannot lock in an old price.
   */
  choosePaymentMethod(telegramId: number, method: PaymentMethod): ChoosePaymentResult {
    const cart = this.carts.get(telegramId);
    if (!cart || cart.state !== "checkout_payment") {
      return { ok: false, error: "در این مرحله امکان انتخاب روش پرداخت نیست" };
    }
    const afterHours = !this.businessHours.isOpenAt(new Date());
    const totals = this.carts.getTotals(telegramId, afterHours);
    if (totals.lines.length === 0) {
      this.carts.resetCheckout(telegramId);
      return { ok: false, error: "سبد خرید شما خالی است" };
    }
    const balance = this.customers.getBalance(telegramId);
    const payment = getPaymentSettings(this.db);
    if (method === "wallet") {
      if (!payment.walletEnabled) {
        return { ok: false, error: "پرداخت با کیف پول توسط مدیر غیرفعال شده است" };
      }
      if (balance < totals.total) {
        return {
          ok: false,
          error: `موجودی کیف پول کافی نیست.\nموجودی: ${formatMoney(balance, getCurrency(this.db))}\nمبلغ سفارش: ${formatMoney(totals.total, getCurrency(this.db))}`,
        };
      }
    } else if (!cardToCardAvailable(payment)) {
      return { ok: false, error: "پرداخت کارت به کارت توسط مدیر غیرفعال شده است" };
    }
    this.carts.setCheckoutTotal(telegramId, totals.total);
    this.carts.setPaymentMethod(telegramId, method);
    return { ok: true, method, total: totals.total, balance };
  }

  /**
   * Attach the card-to-card receipt. Accepting it while the customer is still
   * on the payment-choice screen implicitly selects card-to-card, so a
   * screenshot sent straight after «تسویه حساب» is never rejected.
   */
  attachReceipt(telegramId: number, fileId: string, messageId: number): { ok: true } | { ok: false; error: string } {
    const cart = this.carts.get(telegramId);
    if (!cart || (cart.state !== "checkout_receipt" && cart.state !== "checkout_payment")) {
      return { ok: false, error: "در این مرحله امکان ثبت رسید نیست؛ ابتدا فرایند پرداخت را شروع کنید" };
    }
    if (cart.state === "checkout_payment") {
      this.carts.setPaymentMethod(telegramId, "card_to_card");
    }
    this.carts.setReceipt(telegramId, fileId, messageId);
    return { ok: true };
  }

  /**
   * Place a card-to-card order right after the receipt arrives: the receipt is
   * attached and the order is created in one step (defaults: pickup, now).
   * A price drift mid-checkout parks the cart in `checkout_placed` so the
   * follow-up button press retries against the new total — never a duplicate.
   */
  placeOrderAfterReceipt(
    telegramId: number,
    fileId: string,
    messageId: number,
    customerName?: string | null,
  ): PlaceResult {
    const attach = this.attachReceipt(telegramId, fileId, messageId);
    if (!attach.ok) return { ok: false, reason: "error", error: attach.error };
    const placed = this.placeOrder(telegramId, false, customerName);
    if (!placed.ok && (placed.reason === "price_changed" || placed.reason === "inactive_items")) {
      this.carts.setState(telegramId, "checkout_placed");
    }
    return placed;
  }

  /**
   * The customer's most recent placed-but-pending order inside the edit
   * window — the one the fulfillment buttons on the confirmation message
   * are allowed to change.
   */
  editableOrderFor(telegramId: number): Order | null {
    const row = this.db
      .query(
        `SELECT id FROM orders WHERE customer_telegram_id = ? AND fulfillment_status = 'pending'
         AND created_at >= ? ORDER BY id DESC LIMIT 1`,
      )
      .get(telegramId, new Date(Date.now() - ORDER_EDIT_WINDOW_MS).toISOString()) as
      | { id: number }
      | null;
    return row ? this.loadOrder(row.id) : null;
  }

  /**
   * Create the order for a cart at `checkout_fulfillment`/`checkout_confirm`,
   * or update the already-placed `checkout_placed` row in place (price-changed
   * retry, or a late fulfillment edit). `payWithWallet` is only meaningful for
   * the create path; a placed card order never re-runs the wallet charge.
   */
  private placeOrder(
    telegramId: number,
    payWithWallet: boolean,
    customerName?: string | null,
  ): PlaceResult {
    const cart = this.carts.get(telegramId);
    if (
      !cart ||
      (cart.state !== "checkout_fulfillment" &&
        cart.state !== "checkout_confirm" &&
        cart.state !== "checkout_placed")
    ) {
      return { ok: false, reason: "error", error: "سفارش آماده ثبت نیست؛ فرایند پرداخت را از ابتدا انجام دهید" };
    }
    const useWallet = payWithWallet || cart.paymentMethod === "wallet";
    // A method switched off by the admin must not be honoured, even if the
    // customer reached this stage before the switch was flipped.
    const payment = getPaymentSettings(this.db);
    if (useWallet && !payment.walletEnabled) {
      return { ok: false, reason: "error", error: "پرداخت با کیف پول توسط مدیر غیرفعال شده است" };
    }
    if (!useWallet && !cardToCardAvailable(payment)) {
      return { ok: false, reason: "error", error: "پرداخت کارت به کارت توسط مدیر غیرفعال شده است" };
    }
    // Card-to-card orders must carry the receipt the customer sent.
    if (!useWallet && !cart.receiptFileId) {
      return { ok: false, reason: "error", error: "رسید پرداخت را ارسال کنید" };
    }
    this.carts.pruneInvalidItems(telegramId);
    const afterHours = !this.businessHours.isOpenAt(new Date());
    const totals = this.carts.getTotals(telegramId, afterHours);
    if (totals.lines.length === 0) {
      this.carts.resetCheckout(telegramId);
      return { ok: false, reason: "empty" };
    }
    for (const line of totals.lines) {
      const resolved = this.menu.resolvePrice(line.productId, line.variantId);
      if (!resolved.ok) {
        return { ok: false, reason: "inactive_items", error: resolved.error };
      }
      // Revalidate against the CURRENT applicable price (after-hours aware).
      const currentPrice = resolved.variant
        ? resolved.variant.priceAmount
        : this.menu.priceFor(resolved.product, afterHours);
      if (currentPrice !== line.unitPrice) {
        return { ok: false, reason: "price_changed", total: totals.total, lines: totals.lines };
      }
    }
    if (cart.checkoutTotalAmount !== null && cart.checkoutTotalAmount !== totals.total) {
      this.carts.setCheckoutTotal(telegramId, totals.total);
      return { ok: false, reason: "price_changed", total: totals.total, lines: totals.lines };
    }
    if (useWallet && this.customers.getBalance(telegramId) < totals.total) {
      return { ok: false, reason: "error", error: "موجودی کیف پول کافی نیست" };
    }

    const currency = getCurrency(this.db);

    try {
      const order = tx(this.db, () => {
        // `checkout_placed` means a previous attempt hit a price change BEFORE
        // any row was written — always insert here, never touch an older order.
        const businessDate = this.businessHours.targetBusinessDate(new Date());
        const seq =
          (
            this.db
              .query("SELECT COUNT(*) AS c FROM orders WHERE business_date = ?")
              .get(businessDate) as { c: number }
          ).c + 1;
        const orderNumber = formatOrderNumber(businessDate, seq);
        const createdAt = nowIso();
        const res = this.db
          .query(
            `INSERT INTO orders (order_number, customer_telegram_id, customer_name, business_date,
             total_amount, currency, receipt_file_id, delivery_notes, status,
             fulfillment_status, payment_method, payment_status, fulfillment_method, delivery_time, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'receipt_received_unverified', 'pending', ?, ?, ?, ?, ?)`,
          )
          .run(
            orderNumber,
            telegramId,
            customerName?.trim() || null,
            businessDate,
            totals.total,
            currency,
            useWallet ? null : cart.receiptFileId,
            cart.deliveryNotes,
            useWallet ? "wallet" : "card_to_card",
            useWallet ? "paid" : "receipt_received",
            cart.fulfillmentMethod ?? "pickup",
            cart.fulfillmentTime,
            createdAt,
          );
        const orderId = Number(res.lastInsertRowid);

        // Wallet charge: idempotent per order; rolls back the whole order on failure.
        if (useWallet) {
          const existingDebit = this.db
            .query("SELECT wallet_debit_tx_id FROM orders WHERE id = ?")
            .get(orderId) as { wallet_debit_tx_id: number | null } | null;
          if (!existingDebit?.wallet_debit_tx_id) {
            const pay = this.customers.payOrderFromWallet(telegramId, orderId, totals.total);
            if (!pay.ok) throw new Error(pay.error);
            this.db
              .query("UPDATE orders SET wallet_debit_tx_id = ? WHERE id = ?")
              .run(pay.txId, orderId);
          }
        }

        // The order items are a snapshot of the live cart lines.
        this.db.query("DELETE FROM order_items WHERE order_id = ?").run(orderId);
        const insertItem = this.db.query(
          `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_name,
           quantity, unit_price_amount, line_total_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const line of totals.lines) {
          insertItem.run(
            orderId,
            line.productId,
            line.variantId,
            line.productName,
            line.variantName,
            line.quantity,
            line.unitPrice,
            line.lineTotal,
          );
        }
        // Finalize cart: drop items, reset checkout state.
        this.db.query("DELETE FROM cart_items WHERE cart_id = ?").run(cart.id);
        this.db
          .query(
            `UPDATE carts SET state = 'browsing', payment_method = NULL, receipt_file_id = NULL,
             receipt_message_id = NULL, delivery_notes = NULL, fulfillment_method = NULL,
             fulfillment_time = NULL, checkout_total_amount = NULL,
             updated_at = ? WHERE id = ?`,
          )
          .run(nowIso(), cart.id);

        return this.loadOrder(orderId)!;
      });

      this.notifyLateOrderIfNeeded(order);
      return { ok: true, order };
    } catch (err) {
      return { ok: false, reason: "error", error: `خطا در ثبت سفارش: ${err}` };
    }
  }

  /**
   * Confirm and create the order. Prices are recomputed here (with the
   * after-hours rule applied); if they drifted from the checkout snapshot the
   * caller must show the new amounts and confirm again.
   *
   * The payment method comes from the customer's checkout choice; `payWithWallet`
   * overrides it for callers that already know (tests, admin tooling). A wallet
   * order is charged atomically inside the same transaction as the order row.
   */
  confirmOrder(
    telegramId: number,
    customerName?: string | null,
    payWithWallet?: boolean,
  ): ConfirmResult {
    const result = this.placeOrder(telegramId, payWithWallet ?? false, customerName);
    if (result.ok) return { ok: true, order: result.order };
    if (result.reason === "price_changed") {
      return { ok: false, reason: "price_changed", total: result.total, lines: result.lines };
    }
    if (result.reason === "empty") return { ok: false, reason: "empty" };
    if (result.reason === "inactive_items") {
      return { ok: false, reason: "inactive_items", error: result.error };
    }
    return { ok: false, reason: "error", error: result.error };
  }

  /**
   * Edit delivery method / time on an order that is already placed but not
   * yet confirmed by the café. Only the ordering customer can do this, and
   * only while the order is still `pending`.
   */
  updateFulfillment(
    orderId: number,
    telegramId: number,
    update: { method?: FulfillmentMethod; time?: string | null },
  ): { ok: true; order: Order } | { ok: false; error: string } {
    return tx(this.db, () => {
      const order = this.loadOrderForCustomer(orderId, telegramId);
      if (!order) return { ok: false as const, error: "سفارش یافت نشد" };
      if (order.fulfillmentStatus !== "pending") {
        return { ok: false as const, error: "این سفارش دیگر قابل ویرایش نیست" };
      }
      if (update.method === "delivery") {
        const profile = this.customers.getProfile(telegramId);
        if (!profile?.address) {
          return { ok: false as const, error: "ابتدا آدرس خود را در پروفایل ثبت کنید" };
        }
      }
      const method = update.method ?? order.fulfillmentMethod;
      const time =
        update.time !== undefined
          ? update.time === null
            ? null
            : update.time.trim().slice(0, 100) || null
          : order.deliveryTime;
      this.db
        .query("UPDATE orders SET fulfillment_method = ?, delivery_time = ? WHERE id = ?")
        .run(method, time, orderId);
      return { ok: true as const, order: this.loadOrder(orderId)! };
    });
  }

  /**
   * Enqueue immediate `order_update` notifications so the admin is not silent
   * until tomorrow. Fired for card-to-card orders (they carry a receipt the
   * admin must review right away) and for late orders after the daily report
   * already ran. The refKey/recipient `ON CONFLICT DO NOTHING` dedupes the two
   * paths when both apply.
   */
  private notifyLateOrderIfNeeded(order: Order): void {
    const run = this.db
      .query("SELECT status FROM report_runs WHERE business_date = ?")
      .get(order.businessDate) as { status: string } | null;
    const reportAlreadyGenerated =
      run !== null &&
      (run.status === "sending" ||
        run.status === "sent" ||
        run.status === "failed" ||
        run.status === "skipped_empty");
    const needsReview = order.paymentMethod === "card_to_card" && !!order.receiptFileId;
    if (!reportAlreadyGenerated && !needsReview) return;

    const recipients = this.reportRecipientIds();
    const payload = JSON.stringify({ type: "order_update", orderId: order.id });
    const insert = this.db.query(
      `INSERT INTO notifications (kind, recipient_id, ref_key, status, attempts, next_attempt_at, payload, created_at)
       VALUES ('order_update', ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(kind, ref_key, recipient_id) DO NOTHING`,
    );
    const now = nowIso();
    for (const r of recipients) {
      insert.run(r, order.orderNumber, now, payload, now);
    }
  }

  private reportRecipientIds(): number[] {
    const raw = this.db.query("SELECT value FROM settings WHERE key = 'report_recipients'").get() as
      | { value: string }
      | null;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw.value);
      return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n)) : [];
    } catch {
      return [];
    }
  }

  loadOrder(orderId: number): Order | null {
    const r = this.db.query("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
    if (!r) return null;
    const items = (this.db.query("SELECT * FROM order_items WHERE order_id = ?").all(orderId) as any[]).map(
      (i) => ({
        id: i.id,
        productId: i.product_id ?? null,
        variantId: i.variant_id ?? null,
        productName: i.product_name,
        variantName: i.variant_name ?? null,
        quantity: i.quantity,
        unitPrice: i.unit_price_amount,
        lineTotal: i.line_total_amount,
      }),
    );
    return {
      id: r.id,
      orderNumber: r.order_number,
      customerTelegramId: r.customer_telegram_id,
      customerName: r.customer_name ?? null,
      businessDate: r.business_date,
      totalAmount: r.total_amount,
      currency: r.currency,
      receiptFileId: r.receipt_file_id ?? null,
      deliveryNotes: r.delivery_notes ?? null,
      fulfillmentMethod: r.fulfillment_method ?? "pickup",
      deliveryTime: r.delivery_time ?? null,
      status: r.status,
      fulfillmentStatus: r.fulfillment_status ?? "pending",
      paymentMethod: r.payment_method ?? "card_to_card",
      paymentStatus: r.payment_status ?? (r.receipt_file_id ? "receipt_received" : "unverified"),
      confirmedBy: r.confirmed_by ?? null,
      confirmedAt: r.confirmed_at ?? null,
      deliveredAt: r.delivered_at ?? null,
      paymentReviewedBy: r.payment_reviewed_by ?? null,
      paymentReviewedAt: r.payment_reviewed_at ?? null,
      rejectionReason: r.rejection_reason ?? null,
      createdAt: r.created_at,
      items,
    };
  }

  listByBusinessDate(businessDate: string): Order[] {
    const rows = this.db
      .query("SELECT id FROM orders WHERE business_date = ? ORDER BY id")
      .all(businessDate) as { id: number }[];
    return rows.map((r) => this.loadOrder(r.id)!);
  }

  /** Orders in an inclusive business-date range, capped by `limit` (oldest first). */
  listByDateRange(from: string, to: string, limit = 200): Order[] {
    const rows = this.db
      .query(
        "SELECT id FROM orders WHERE business_date >= ? AND business_date <= ? ORDER BY business_date, id LIMIT ?",
      )
      .all(from, to, limit) as { id: number }[];
    return rows.map((r) => this.loadOrder(r.id)!);
  }

  listRecent(limit = 20): Order[] {
    const rows = this.db
      .query("SELECT id FROM orders ORDER BY id DESC LIMIT ?")
      .all(limit) as { id: number }[];
    return rows.map((r) => this.loadOrder(r.id)!);
  }

  /** Most recent order for a customer (order-status questions). */
  latestOrderFor(telegramId: number): Order | null {
    const row = this.db
      .query("SELECT id FROM orders WHERE customer_telegram_id = ? ORDER BY id DESC LIMIT 1")
      .get(telegramId) as { id: number } | null;
    return row ? this.loadOrder(row.id) : null;
  }

  /** Load by the unique human-readable order number (admin panel actions). */
  findByNumber(orderNumber: string): Order | null {
    const row = this.db
      .query("SELECT id FROM orders WHERE order_number = ?")
      .get(orderNumber) as { id: number } | null;
    return row ? this.loadOrder(row.id) : null;
  }

  /** One page of a customer's order history, newest first. Scoped by caller id. */
  listForCustomer(telegramId: number, limit = 10, offset = 0): Order[] {
    const rows = this.db
      .query(
        "SELECT id FROM orders WHERE customer_telegram_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .all(telegramId, limit, offset) as { id: number }[];
    return rows.map((r) => this.loadOrder(r.id)!);
  }

  countForCustomer(telegramId: number): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS c FROM orders WHERE customer_telegram_id = ?")
        .get(telegramId) as { c: number }
    ).c;
  }

  /**
   * Load an order ONLY for the requesting customer. Returns null when the
   * order belongs to someone else — cross-customer access is impossible.
   */
  loadOrderForCustomer(orderId: number, telegramId: number): Order | null {
    const order = this.loadOrder(orderId);
    if (!order || order.customerTelegramId !== telegramId) return null;
    return order;
  }

  // ---------- fulfillment lifecycle ----------

  /**
   * pending → confirmed → delivered. Transitions are validated against the
   * persisted state inside a transaction; repeats return `already`.
   * Payment status is NOT changed here — confirming never marks an order paid.
   */
  markConfirmed(orderId: number, adminId: number):
    | { ok: true; order: Order; already: boolean }
    | { ok: false; error: string } {
    return tx(this.db, () => {
      const r = this.db
        .query(
          `UPDATE orders SET fulfillment_status = 'confirmed', confirmed_by = ?, confirmed_at = ?
           WHERE id = ? AND fulfillment_status = 'pending'`,
        )
        .run(adminId, nowIso(), orderId);
      if (r.changes === 1) {
        return { ok: true as const, order: this.loadOrder(orderId)!, already: false };
      }
      const current = this.loadOrder(orderId);
      if (current && current.fulfillmentStatus === "confirmed") {
        return { ok: true as const, order: current, already: true };
      }
      return { ok: false as const, error: "این سفارش در وضعیت تأیید نیست" };
    });
  }

  /** confirmed → delivered (idempotent like markConfirmed). */
  markDelivered(orderId: number, adminId: number):
    | { ok: true; order: Order; already: boolean }
    | { ok: false; error: string } {
    return tx(this.db, () => {
      const r = this.db
        .query(
          `UPDATE orders SET fulfillment_status = 'delivered', delivered_at = ?
           WHERE id = ? AND fulfillment_status = 'confirmed'`,
        )
        .run(nowIso(), orderId);
      if (r.changes === 1) {
        return { ok: true as const, order: this.loadOrder(orderId)!, already: false };
      }
      const current = this.loadOrder(orderId);
      if (current && current.fulfillmentStatus === "delivered") {
        return { ok: true as const, order: current, already: true };
      }
      return { ok: false as const, error: "این سفارش در وضعیت تحویل نیست" };
    });
  }

  // ---------- payment review ----------

  /**
   * Admin approves a card-to-card payment: the receipt is accepted and the
   * order is marked paid. Only orders that actually carry a receipt can be
   * approved — a wallet order is already paid at creation time. Idempotent.
   */
  markPaymentPaid(orderId: number, adminId: number):
    | { ok: true; order: Order; already: boolean }
    | { ok: false; error: string } {
    return tx(this.db, () => {
      const current = this.loadOrder(orderId);
      if (!current) return { ok: false as const, error: "سفارش یافت نشد" };
      if (current.paymentStatus === "paid") {
        return { ok: true as const, order: current, already: true };
      }
      if (current.paymentMethod !== "card_to_card" || !current.receiptFileId) {
        return { ok: false as const, error: "این سفارش رسید کارت به کارت ندارد" };
      }
      this.db
        .query(
          `UPDATE orders SET payment_status = 'paid', payment_reviewed_by = ?, payment_reviewed_at = ?
           WHERE id = ? AND payment_status != 'paid'`,
        )
        .run(adminId, nowIso(), orderId);
      return { ok: true as const, order: this.loadOrder(orderId)!, already: false };
    });
  }

  /**
   * Admin rejects a card-to-card receipt (wrong amount, unreadable, unpaid).
   * `reason` is stored for the customer notice; the bot keyboard path always
   * supplies one (it asks the admin first), the panel may omit it.
   */
  markPaymentRejected(orderId: number, adminId: number, reason: string | null):
    | { ok: true; order: Order; already: boolean }
    | { ok: false; error: string } {
    const trimmed = (reason ?? "").trim().slice(0, 500) || null;
    return tx(this.db, () => {
      const current = this.loadOrder(orderId);
      if (!current) return { ok: false as const, error: "سفارش یافت نشد" };
      if (current.paymentStatus === "rejected") {
        return { ok: true as const, order: current, already: true };
      }
      if (current.paymentStatus === "paid") {
        return { ok: false as const, error: "پرداخت این سفارش قبلاً تأیید شده است" };
      }
      this.db
        .query(
          `UPDATE orders SET payment_status = 'rejected', payment_reviewed_by = ?, payment_reviewed_at = ?,
           rejection_reason = ?
           WHERE id = ? AND payment_status != 'paid'`,
        )
        .run(adminId, nowIso(), trimmed, orderId);
      return { ok: true as const, order: this.loadOrder(orderId)!, already: false };
    });
  }

  countByBusinessDate(businessDate: string): number {
    return (
      this.db.query("SELECT COUNT(*) AS c FROM orders WHERE business_date = ?").get(businessDate) as {
        c: number;
      }
    ).c;
  }
}
