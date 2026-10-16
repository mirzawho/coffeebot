import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";
import { formatOrderNumber, MAX_DELIVERY_NOTES_LENGTH } from "../utils/ids";
import { BusinessHoursService } from "./business-hours";
import { CartService, type CartLine } from "./cart";
import { MenuService } from "./menu";
import { CustomersService } from "./customers";
import { getCurrency, getPaymentSettings, type PaymentSettings } from "./settings";

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
  status: string;
  fulfillmentStatus: FulfillmentStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  confirmedBy: number | null;
  confirmedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  items: OrderItem[];
}

export type ConfirmResult =
  | { ok: true; order: Order }
  | { ok: false; reason: "price_changed"; total: number; lines: CartLine[] }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "inactive_items"; error: string }
  | { ok: false; reason: "error"; error: string };

export type StartCheckoutResult =
  | { ok: true; lines: CartLine[]; total: number; payment: PaymentSettings }
  | { ok: false; reason: "empty" | "invalid_items" | "payment_unconfigured"; error: string };

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

  getPaymentInstructions(telegramId: number): {
    payment: PaymentSettings;
    total: number;
    lines: CartLine[];
  } {
    const totals = this.carts.getTotals(telegramId);
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
    // Without a configured payment method the customer would be led through a
    // fake payment flow — refuse before entering any checkout state.
    const payment = getPaymentSettings(this.db);
    if (!payment.cardNumber) {
      return {
        ok: false,
        reason: "payment_unconfigured",
        error:
          "پرداخت هنوز راه‌اندازی نشده است؛ لطفاً بعداً دوباره تلاش کنید یا برای هماهنگی با کافه تماس بگیرید.",
      };
    }
    this.carts.setCheckoutTotal(telegramId, totals.total);
    this.carts.setState(telegramId, "checkout_receipt");
    return {
      ok: true,
      lines: totals.lines,
      total: totals.total,
      payment,
    };
  }

  attachReceipt(telegramId: number, fileId: string, messageId: number): { ok: true } | { ok: false; error: string } {
    const cart = this.carts.get(telegramId);
    if (!cart || cart.state !== "checkout_receipt") {
      return { ok: false, error: "در این مرحله امکان ثبت رسید نیست؛ ابتدا فرایند پرداخت را شروع کنید" };
    }
    this.carts.setReceipt(telegramId, fileId, messageId);
    return { ok: true };
  }

  setDeliveryNotes(telegramId: number, notes: string | null): { ok: true } | { ok: false; error: string } {
    const cart = this.carts.get(telegramId);
    if (!cart || cart.state !== "checkout_delivery") {
      return { ok: false, error: "در این مرحله امکان ثبت اطلاعات تحویل نیست" };
    }
    if (notes !== null) {
      const trimmed = notes.trim();
      if (trimmed.length > MAX_DELIVERY_NOTES_LENGTH) {
        return { ok: false, error: "یادداشت تحویل بیش از حد مجاز طولانی است" };
      }
      this.carts.setDeliveryNotes(telegramId, trimmed || null);
    } else {
      this.carts.setDeliveryNotes(telegramId, null);
    }
    return { ok: true };
  }

  /**
   * Confirm and create the order. Prices are recomputed here (with the
   * after-hours rule applied); if they drifted from the checkout snapshot the
   * caller must show the new amounts and confirm again.
   * `payWithWallet` charges the customer's wallet atomically on success.
   */
  confirmOrder(
    telegramId: number,
    customerName?: string | null,
    payWithWallet = false,
  ): ConfirmResult {
    const cart = this.carts.get(telegramId);
    if (!cart || cart.state !== "checkout_confirm") {
      return { ok: false, reason: "error", error: "سفارش آماده تأیید نیست؛ فرایند پرداخت را از ابتدا انجام دهید" };
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
    if (payWithWallet && this.customers.getBalance(telegramId) < totals.total) {
      return { ok: false, reason: "error", error: "موجودی کیف پول کافی نیست" };
    }

    const currency = getCurrency(this.db);
    const businessDate = this.businessHours.targetBusinessDate(new Date());

    try {
      const order = tx(this.db, () => {
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
             fulfillment_status, payment_method, payment_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'receipt_received_unverified', 'pending', ?, ?, ?)`,
          )
          .run(
            orderNumber,
            telegramId,
            customerName?.trim() || null,
            businessDate,
            totals.total,
            currency,
            payWithWallet ? null : cart.receiptFileId,
            cart.deliveryNotes,
            payWithWallet ? "wallet" : "card_to_card",
            payWithWallet ? "paid" : "receipt_received",
            createdAt,
          );
        const orderId = Number(res.lastInsertRowid);

        // Wallet charge: idempotent per order; rolls back the whole order on failure.
        if (payWithWallet) {
          const pay = this.customers.payOrderFromWallet(telegramId, orderId, totals.total);
          if (!pay.ok) throw new Error(pay.error);
          this.db
            .query("UPDATE orders SET wallet_debit_tx_id = ? WHERE id = ?")
            .run(pay.txId, orderId);
        }

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
            `UPDATE carts SET state = 'browsing', receipt_file_id = NULL, receipt_message_id = NULL,
             delivery_notes = NULL, checkout_total_amount = NULL, updated_at = ? WHERE id = ?`,
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
   * If the daily report for this business date was already generated (sent,
   * mid-send, failed, or skipped as empty), enqueue immediate order_update
   * notifications so the order is not silent until tomorrow.
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
    if (!reportAlreadyGenerated) return;

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
      status: r.status,
      fulfillmentStatus: r.fulfillment_status ?? "pending",
      paymentMethod: r.payment_method ?? "card_to_card",
      paymentStatus: r.payment_status ?? (r.receipt_file_id ? "receipt_received" : "unverified"),
      confirmedBy: r.confirmed_by ?? null,
      confirmedAt: r.confirmed_at ?? null,
      deliveredAt: r.delivered_at ?? null,
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

  countByBusinessDate(businessDate: string): number {
    return (
      this.db.query("SELECT COUNT(*) AS c FROM orders WHERE business_date = ?").get(businessDate) as {
        c: number;
      }
    ).c;
  }
}
