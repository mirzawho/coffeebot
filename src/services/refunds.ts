import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";
import { cardLast4, maskCardNumber } from "../utils/cards";
import { log } from "../utils/logger";
import { CustomersService } from "./customers";
import type { Order, OrderItem } from "./orders";

/**
 * Order refunds: item-level, multi-item, and full-order, settled either to
 * the customer's wallet (immediate ledger credit) or to their registered bank
 * card (recorded as a pending payable; an admin confirms completion after
 * making the transfer manually — there is no bank integration).
 *
 * Accounting invariants:
 *  - remaining refundable quantity per item = quantity − SUM(quantity of
 *    refunds in ('pending','completed')) — cancelled refunds free the amount;
 *  - cumulative refunds can never exceed the amount actually paid
 *    (orders.payment_status must be 'paid'; the cap is the order total);
 *  - money is integer toman; every multi-row mutation runs in one IMMEDIATE
 *    transaction; wallet credits are idempotent per refund row.
 */

export type RefundSettlement = "wallet" | "card";
export type RefundStatus = "pending" | "completed" | "cancelled";

export const REFUND_REASON_CODES = [
  "item_issue",
  "wrong_item",
  "quality",
  "stock",
  "customer_request",
  "other",
] as const;
export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

export const REFUND_REASON_LABELS: Record<RefundReasonCode, string> = {
  item_issue: "مشکل در آیتم سفارش",
  wrong_item: "آیتم اشتباه",
  quality: "کیفیت نامناسب",
  stock: "کمبود موجودی",
  customer_request: "درخواست مشتری",
  other: "سایر موارد",
};

export interface Refund {
  id: number;
  orderId: number;
  orderItemId: number;
  customerTelegramId: number;
  quantity: number;
  amount: number;
  settlementMethod: RefundSettlement;
  status: RefundStatus;
  reasonCode: RefundReasonCode | null;
  reasonText: string | null;
  cardLast4: string | null;
  cardMasked: string | null;
  cardholderName: string | null;
  walletTxId: number | null;
  createdBy: number;
  createdAt: string;
  completedBy: number | null;
  completedAt: string | null;
  cancelledBy: number | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface RefundableItem extends OrderItem {
  refundedQuantity: number;
  refundableQuantity: number;
  refundableAmount: number;
}

export interface RefundSummary {
  totalAmount: number;
  refundedAmount: number;
  remainingRefundableAmount: number;
  items: RefundableItem[];
}

export interface CreateRefundItemInput {
  orderItemId: number;
  quantity: number;
}

export interface CreateRefundInput {
  settlementMethod: RefundSettlement;
  /** Client-generated unique key; replays return the original result. */
  idempotencyKey: string;
  createdBy: number;
  reasonCode?: string | null;
  reasonText?: string | null;
  /** Required for card settlement: snapshot taken from the customer's saved card. */
  card?: { number: string; cardholderName: string | null } | null;
}

export type CreateRefundResult =
  | { ok: true; refunds: Refund[]; totalAmount: number; already: boolean; balanceAfter?: number }
  | { ok: false; error: string };

const MAX_REASON_TEXT = 200;
const MAX_IDEMPOTENCY_KEY = 100;

export class RefundsService {
  private customers: CustomersService;

  constructor(private readonly db: Db) {
    this.customers = new CustomersService(db);
  }

  // ---------- reads ----------

  listForOrder(orderId: number): Refund[] {
    const rows = this.db
      .query("SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC")
      .all(orderId) as any[];
    return rows.map(rowToRefund);
  }

  listPendingCard(limit = 50): Refund[] {
    const rows = this.db
      .query(
        "SELECT * FROM refunds WHERE settlement_method = 'card' AND status = 'pending' ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as any[];
    return rows.map(rowToRefund);
  }

  getRefund(id: number): Refund | null {
    const r = this.db.query("SELECT * FROM refunds WHERE id = ?").get(id) as any;
    return r ? rowToRefund(r) : null;
  }

  /**
   * Per-item refundability + aggregate refund state for one order. Uses the
   * historical order-item unit price, never the product's current price.
   */
  summarize(order: Order): RefundSummary {
    const items: RefundableItem[] = order.items.map((item) => {
      const refundedQty = (
        this.db
          .query(
            `SELECT COALESCE(SUM(quantity), 0) AS q FROM refunds
             WHERE order_item_id = ? AND status IN ('pending', 'completed')`,
          )
          .get(item.id) as { q: number }
      ).q;
      const refundableQuantity = Math.max(0, item.quantity - refundedQty);
      return {
        ...item,
        refundedQuantity: refundedQty,
        refundableQuantity,
        refundableAmount: refundableQuantity * item.unitPrice,
      };
    });
    const remaining = items.reduce((s, i) => s + i.refundableAmount, 0);
    const refundedAmount = (
      this.db
        .query(
          `SELECT COALESCE(SUM(amount), 0) AS a FROM refunds
           WHERE order_id = ? AND status IN ('pending', 'completed')`,
        )
        .get(order.id) as { a: number }
    ).a;
    return {
      totalAmount: order.totalAmount,
      refundedAmount,
      remainingRefundableAmount: remaining,
      items,
    };
  }

  // ---------- mutations ----------

  /**
   * Refund selected quantities of order items. Every financial rule is
   * enforced here, on the server, inside one IMMEDIATE transaction.
   */
  createItemRefunds(order: Order, items: CreateRefundItemInput[], input: CreateRefundInput): CreateRefundResult {
    const validation = this.validateCreate(order, items, input);
    if (validation) return { ok: false, error: validation };

    try {
      return tx(this.db, () => {
        // Idempotent replay: same key returns the original refunds.
        const existing = this.db
          .query("SELECT * FROM refunds WHERE idempotency_key = ? ORDER BY id")
          .all(input.idempotencyKey) as any[];
        if (existing.length > 0) {
          return {
            ok: true as const,
            refunds: existing.map(rowToRefund),
            totalAmount: existing.reduce((s, r) => s + r.amount, 0),
            already: true,
          };
        }

        // Re-validate quantities against fresh data inside the transaction
        // (protects against concurrent refunds between check and commit).
        const fresh = this.summarize(this.reloadOrder(order.id)!);
        const byItem = new Map(fresh.items.map((i) => [i.id, i]));
        const reasonCode = this.cleanReasonCode(input.reasonCode);
        const reasonText = this.cleanReasonText(input.reasonText, reasonCode);
        const refunds: Refund[] = [];
        let totalAmount = 0;
        let balanceAfter: number | undefined;

        for (const req of items) {
          const item = byItem.get(req.orderItemId);
          if (!item) throw new RefundError("آیتم سفارش یافت نشد");
          if (req.quantity > item.refundableQuantity) {
            throw new RefundError(`موجودی قابل بازگشت «${item.productName}» کافی نیست`);
          }
          const amount = req.quantity * item.unitPrice;
          if (amount <= 0) throw new RefundError("مبلغ بازگشت باید بیشتر از صفر باشد");

          const isWallet = input.settlementMethod === "wallet";
          const res = this.db
            .query(
              `INSERT INTO refunds (
                 order_id, order_item_id, customer_telegram_id, quantity, amount,
                 settlement_method, status, reason_code, reason_text,
                 card_last4, card_masked, cardholder_name, idempotency_key,
                 created_by, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              order.id,
              item.id,
              order.customerTelegramId,
              req.quantity,
              amount,
              input.settlementMethod,
              isWallet ? "completed" : "pending",
              reasonCode,
              reasonText,
              input.card ? cardLast4(input.card.number) : null,
              input.card ? maskCardNumber(input.card.number) : null,
              input.card?.cardholderName ?? null,
              // One key covers the whole operation; per-row keys stay unique.
              refunds.length === 0 ? input.idempotencyKey : `${input.idempotencyKey}#${refunds.length}`,
              input.createdBy,
              nowIso(),
            );
          const refundId = Number(res.lastInsertRowid);

          if (isWallet) {
            // The ledger row FKs customer_profiles; an order placed without a
            // saved profile still needs a minimal one before the credit.
            if (!this.customers.getProfile(order.customerTelegramId)) {
              this.customers.saveProfile(order.customerTelegramId, {
                fullName: order.customerName || "مشتری",
              });
            }
            const credit = this.customers.creditOrderRefund(
              order.customerTelegramId,
              refundId,
              amount,
              input.createdBy,
              `بازگشت وجه سفارش ${order.orderNumber}`,
            );
            if (!credit.applied) throw new RefundError("اعتبارسنجی کیف پول تکراری است");
            this.db
              .query("UPDATE refunds SET wallet_tx_id = ? WHERE id = ?")
              .run(credit.tx.id, refundId);
            balanceAfter = credit.tx.balanceAfter;
          }

          refunds.push(this.getRefund(refundId)!);
          totalAmount += amount;
        }

        return { ok: true as const, refunds, totalAmount, already: false, balanceAfter };
      });
    } catch (err) {
      if (err instanceof RefundError) return { ok: false, error: err.message };
      const msg = String((err as any)?.message ?? err);
      log.warn("refund create failed", { orderId: order.id, err: msg });
      if (msg.includes("UNIQUE constraint failed: refunds.idempotency_key")) {
        // Lost a race on the same key — return what the winner wrote.
        const winner = this.db
          .query("SELECT * FROM refunds WHERE idempotency_key = ? ORDER BY id")
          .all(input.idempotencyKey) as any[];
        if (winner.length > 0) {
          return {
            ok: true,
            refunds: winner.map(rowToRefund),
            totalAmount: winner.reduce((s, r) => s + r.amount, 0),
            already: true,
          };
        }
      }
      if (msg === "WALLET_LIMIT") {
        return { ok: false, error: "موجودی کیف پول از حد مجاز بیشتر می‌شود" };
      }
      return { ok: false, error: "بازگشت وجه انجام نشد؛ دوباره تلاش کنید" };
    }
  }

  /** Refund every remaining refundable quantity in the order. */
  createFullOrderRefund(order: Order, input: CreateRefundInput): CreateRefundResult {
    const summary = this.summarize(order);
    const items = summary.items
      .filter((i) => i.refundableQuantity > 0)
      .map((i) => ({ orderItemId: i.id, quantity: i.refundableQuantity }));
    if (items.length === 0) {
      return { ok: false, error: "مبلغ قابل بازگشتی برای این سفارش باقی نمانده است" };
    }
    return this.createItemRefunds(order, items, input);
  }

  /**
   * Admin confirms a pending card refund was transferred manually. Does not
   * touch the wallet and never creates a second refund. Idempotent.
   */
  completeCardRefund(refundId: number, adminId: number):
    | { ok: true; refund: Refund; already: boolean }
    | { ok: false; error: string } {
    return tx(this.db, () => {
      const current = this.getRefund(refundId);
      if (!current) return { ok: false as const, error: "ریفاند یافت نشد" };
      if (current.settlementMethod !== "card") {
        return { ok: false as const, error: "فقط ریفاند کارت قابل تکمیل است" };
      }
      if (current.status === "completed") {
        return { ok: true as const, refund: current, already: true };
      }
      if (current.status !== "pending") {
        return { ok: false as const, error: "این ریفاند قبلاً لغو شده است" };
      }
      this.db
        .query(
          `UPDATE refunds SET status = 'completed', completed_by = ?, completed_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(adminId, nowIso(), refundId);
      return { ok: true as const, refund: this.getRefund(refundId)!, already: false };
    });
  }

  /**
   * Cancel a still-pending card refund (frees the refundable amount again).
   * Completed refunds are financially immutable. To change the settlement
   * method the admin cancels and then creates a new refund.
   */
  cancelRefund(refundId: number, adminId: number, reason: string | null):
    | { ok: true; refund: Refund }
    | { ok: false; error: string } {
    const trimmed = (reason ?? "").trim().slice(0, MAX_REASON_TEXT) || null;
    return tx(this.db, () => {
      const current = this.getRefund(refundId);
      if (!current) return { ok: false as const, error: "ریفاند یافت نشد" };
      if (current.status === "cancelled") {
        return { ok: true as const, refund: current };
      }
      if (current.status !== "pending") {
        return { ok: false as const, error: "ریفاند تکمیل‌شده قابل لغو نیست" };
      }
      this.db
        .query(
          `UPDATE refunds SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(adminId, nowIso(), trimmed, refundId);
      return { ok: true as const, refund: this.getRefund(refundId)! };
    });
  }

  // ---------- validation helpers ----------

  /** Returns an error message, or null when the request is valid. */
  private validateCreate(
    order: Order,
    items: CreateRefundItemInput[],
    input: CreateRefundInput,
  ): string | null {
    if (input.settlementMethod !== "wallet" && input.settlementMethod !== "card") {
      return "روش بازگشت وجه نامعتبر است";
    }
    const key = String(input.idempotencyKey ?? "").trim();
    if (!key || key.length > MAX_IDEMPOTENCY_KEY) return "کلید درخواست نامعتبر است";
    if (!Array.isArray(items) || items.length === 0) {
      return "حداقل یک آیتم برای بازگشت انتخاب کنید";
    }
    if (!Number.isInteger(input.createdBy) || input.createdBy <= 0) {
      return "هویت مدیر نامعتبر است";
    }
    if (order.paymentStatus !== "paid") {
      return "این سفارش هنوز پرداخت نشده است؛ بازگشت وجه فقط برای سفارش‌های پرداخت‌شده مجاز است";
    }
    if (input.settlementMethod === "card") {
      if (!input.card?.number) {
        return "مشتری شماره کارت ثبت‌نکرده است؛ ابتدا کارت او را ثبت کنید یا بازگشت به کیف پول را انتخاب کنید";
      }
    }
    if (input.reasonCode != null && !REFUND_REASON_CODES.includes(input.reasonCode as RefundReasonCode)) {
      return "دلیل بازگشت نامعتبر است";
    }
    for (const it of items) {
      if (!Number.isInteger(it.orderItemId) || it.orderItemId <= 0) return "آیتم سفارش نامعتبر است";
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        return "تعداد بازگشت باید عدد صحیح مثبت باشد";
      }
    }
    // Duplicate line items in one request would double-count; merge check.
    const seen = new Set<number>();
    for (const it of items) {
      if (seen.has(it.orderItemId)) return "هر آیتم سفارش فقط یک‌بار می‌تواند در درخواست باشد";
      seen.add(it.orderItemId);
    }
    return null;
  }

  private cleanReasonCode(raw: string | null | undefined): RefundReasonCode | null {
    if (!raw) return null;
    return REFUND_REASON_CODES.includes(raw as RefundReasonCode) ? (raw as RefundReasonCode) : null;
  }

  private cleanReasonText(raw: string | null | undefined, code: RefundReasonCode | null): string | null {
    const text = String(raw ?? "").trim().slice(0, MAX_REASON_TEXT) || null;
    if (code === "other") return text; // optional free text for "سایر موارد"
    return text;
  }

  private reloadOrder(orderId: number): Order | null {
    // Local minimal loader to avoid a circular import with OrdersService.
    const r = this.db.query("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
    if (!r) return null;
    const items = this.db
      .query("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
      .all(orderId) as any[];
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
      fulfillmentMethod: r.fulfillment_method,
      deliveryTime: r.delivery_time ?? null,
      status: r.status,
      fulfillmentStatus: r.fulfillment_status,
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      confirmedBy: r.confirmed_by ?? null,
      confirmedAt: r.confirmed_at ?? null,
      deliveredAt: r.delivered_at ?? null,
      paymentReviewedBy: r.payment_reviewed_by ?? null,
      paymentReviewedAt: r.payment_reviewed_at ?? null,
      rejectionReason: r.rejection_reason ?? null,
      createdAt: r.created_at,
      items: items.map((i) => ({
        id: i.id,
        productId: i.product_id ?? null,
        variantId: i.variant_id ?? null,
        productName: i.product_name,
        variantName: i.variant_name ?? null,
        quantity: i.quantity,
        unitPrice: i.unit_price_amount,
        lineTotal: i.line_total_amount,
      })),
    };
  }
}

/** Internal control-flow for Persian validation errors inside transactions. */
class RefundError extends Error {}

function rowToRefund(r: any): Refund {
  return {
    id: r.id,
    orderId: r.order_id,
    orderItemId: r.order_item_id,
    customerTelegramId: r.customer_telegram_id,
    quantity: r.quantity,
    amount: r.amount,
    settlementMethod: r.settlement_method,
    status: r.status,
    reasonCode: r.reason_code ?? null,
    reasonText: r.reason_text ?? null,
    cardLast4: r.card_last4 ?? null,
    cardMasked: r.card_masked ?? null,
    cardholderName: r.cardholder_name ?? null,
    walletTxId: r.wallet_tx_id ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    completedBy: r.completed_by ?? null,
    completedAt: r.completed_at ?? null,
    cancelledBy: r.cancelled_by ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelReason: r.cancel_reason ?? null,
  };
}
