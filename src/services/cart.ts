import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";
import { MAX_CART_ITEMS, MAX_ITEM_QUANTITY } from "../utils/ids";
import { MenuService } from "./menu";

export type CartState =
  | "browsing"
  | "checkout_payment"
  | "checkout_receipt"
  | "checkout_fulfillment"
  | "checkout_confirm"
  | "checkout_placed";

/** How the customer chose to pay. Null until they pick at checkout. */
export type CartPaymentMethod = "card_to_card" | "wallet";

/** How the order reaches the customer. */
export type FulfillmentMethod = "delivery" | "pickup";

export interface Cart {
  id: number;
  telegramId: number;
  state: CartState;
  paymentMethod: CartPaymentMethod | null;
  receiptFileId: string | null;
  receiptMessageId: number | null;
  deliveryNotes: string | null;
  fulfillmentMethod: FulfillmentMethod | null;
  fulfillmentTime: string | null;
  checkoutTotalAmount: number | null;
}

export interface CartLine {
  cartItemId: number;
  productId: number;
  variantId: number | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CartTotals {
  lines: CartLine[];
  total: number;
  itemCount: number;
}

export type CartOpResult = { ok: true } | { ok: false; error: string };

export class CartService {
  private menu: MenuService;

  constructor(private readonly db: Db) {
    this.menu = new MenuService(db);
  }

  getOrCreate(telegramId: number): Cart {
    const row = this.db.query("SELECT * FROM carts WHERE telegram_id = ?").get(telegramId) as any;
    if (row) return this.rowToCart(row);
    this.db
      .query(
        "INSERT INTO carts (telegram_id, state, created_at, updated_at) VALUES (?, 'browsing', ?, ?)",
      )
      .run(telegramId, nowIso(), nowIso());
    return this.rowToCart(
      this.db.query("SELECT * FROM carts WHERE telegram_id = ?").get(telegramId) as any,
    );
  }

  private rowToCart(r: any): Cart {
    return {
      id: r.id,
      telegramId: r.telegram_id,
      state: r.state,
      paymentMethod: r.payment_method ?? null,
      receiptFileId: r.receipt_file_id ?? null,
      receiptMessageId: r.receipt_message_id ?? null,
      deliveryNotes: r.delivery_notes ?? null,
      fulfillmentMethod: r.fulfillment_method ?? null,
      fulfillmentTime: r.fulfillment_time ?? null,
      checkoutTotalAmount: r.checkout_total_amount ?? null,
    };
  }

  get(telegramId: number): Cart | null {
    const row = this.db.query("SELECT * FROM carts WHERE telegram_id = ?").get(telegramId) as any;
    return row ? this.rowToCart(row) : null;
  }

  setState(telegramId: number, state: CartState): void {
    this.getOrCreate(telegramId);
    this.db
      .query("UPDATE carts SET state = ?, updated_at = ? WHERE telegram_id = ?")
      .run(state, nowIso(), telegramId);
  }

  addItem(telegramId: number, productId: number, variantId: number | null, qty: number): CartOpResult {
    const cart = this.getOrCreate(telegramId);
    if (cart.state !== "browsing") {
      return { ok: false, error: "ابتدا سفارش جاری را تکمیل یا لغو کنید" };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ITEM_QUANTITY) {
      return { ok: false, error: `تعداد باید بین ۱ و ${MAX_ITEM_QUANTITY} باشد` };
    }
    const resolved = this.menu.resolvePrice(productId, variantId);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    return tx(this.db, () => {
      const existing = this.db
        .query(
          "SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_id IS ?",
        )
        .get(cart.id, productId, variantId) as { id: number; quantity: number } | null;
      if (existing) {
        const newQty = existing.quantity + qty;
        if (newQty > MAX_ITEM_QUANTITY) {
          return { ok: false, error: `حداکثر تعداد برای این قلم ${MAX_ITEM_QUANTITY} است` };
        }
        this.db
          .query("UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?")
          .run(newQty, nowIso(), existing.id);
        return { ok: true };
      }
      const count = (
        this.db.query("SELECT COUNT(*) AS c FROM cart_items WHERE cart_id = ?").get(cart.id) as {
          c: number;
        }
      ).c;
      if (count >= MAX_CART_ITEMS) {
        return { ok: false, error: "سبد خرید پر است؛ ابتدا برخی اقلام را حذف کنید" };
      }
      this.db
        .query(
          "INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(cart.id, productId, variantId, qty, nowIso(), nowIso());
      return { ok: true };
    });
  }

  changeQty(telegramId: number, cartItemId: number, delta: number): CartOpResult {
    const cart = this.get(telegramId);
    if (!cart) return { ok: false, error: "سبد خرید یافت نشد" };
    if (cart.state !== "browsing") return { ok: false, error: "سفارش جاری در حال تکمیل است" };
    const item = this.db
      .query("SELECT * FROM cart_items WHERE id = ? AND cart_id = ?")
      .get(cartItemId, cart.id) as any;
    if (!item) return { ok: false, error: "این قلم دیگر در سبد نیست" };
    const newQty = item.quantity + delta;
    if (newQty <= 0) {
      return this.removeItem(telegramId, cartItemId);
    }
    if (newQty > MAX_ITEM_QUANTITY) {
      return { ok: false, error: `حداکثر تعداد برای این قلم ${MAX_ITEM_QUANTITY} است` };
    }
    this.db
      .query("UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?")
      .run(newQty, nowIso(), cartItemId);
    return { ok: true };
  }

  /**
   * Set the absolute quantity of a cart line identified by product/variant.
   * Quantity 0 removes the line. Validates availability on every call.
   */
  setQty(
    telegramId: number,
    productId: number,
    variantId: number | null,
    quantity: number,
  ): CartOpResult {
    const cart = this.getOrCreate(telegramId);
    if (cart.state !== "browsing") {
      return { ok: false, error: "ابتدا سفارش جاری را تکمیل یا لغو کنید" };
    }
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_ITEM_QUANTITY) {
      return { ok: false, error: `تعداد باید بین ۰ و ${MAX_ITEM_QUANTITY} باشد` };
    }
    const item = this.db
      .query(
        "SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ? AND variant_id IS ?",
      )
      .get(cart.id, productId, variantId) as { id: number; quantity: number } | null;
    if (!item) return { ok: false, error: "این قلم در سبد شما نیست" };
    if (quantity === 0) {
      return this.removeItem(telegramId, item.id);
    }
    // Revalidate availability/price — an item can become unorderable at any time.
    const resolved = this.menu.resolvePrice(productId, variantId);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    this.db
      .query("UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?")
      .run(quantity, nowIso(), item.id);
    return { ok: true };
  }

  removeItem(telegramId: number, cartItemId: number): CartOpResult {
    const cart = this.get(telegramId);
    if (!cart) return { ok: false, error: "سبد خرید یافت نشد" };
    if (cart.state !== "browsing") return { ok: false, error: "سفارش جاری در حال تکمیل است" };
    const res = this.db
      .query("DELETE FROM cart_items WHERE id = ? AND cart_id = ?")
      .run(cartItemId, cart.id);
    if (res.changes === 0) return { ok: false, error: "این قلم دیگر در سبد نیست" };
    return { ok: true };
  }

  clear(telegramId: number): void {
    const cart = this.get(telegramId);
    if (!cart) return;
    this.db.transaction(() => {
      this.db.query("DELETE FROM cart_items WHERE cart_id = ?").run(cart.id);
      this.db
        .query(
          `UPDATE carts SET state = 'browsing', payment_method = NULL, receipt_file_id = NULL,
           receipt_message_id = NULL, delivery_notes = NULL, checkout_total_amount = NULL,
           updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), cart.id);
    })();
  }

  /**
   * Live-priced cart contents; server is the source of truth.
   * `afterHours` applies the configured after-hours price to fixed-price
   * products that have one (variants keep their own price).
   */
  getTotals(telegramId: number, afterHours = false): CartTotals {
    const cart = this.get(telegramId);
    if (!cart) return { lines: [], total: 0, itemCount: 0 };
    const rows = this.db
      .query(
        `SELECT ci.id, ci.product_id, ci.variant_id, ci.quantity, p.name AS product_name,
                v.name AS variant_name, p.fixed_price_amount, p.after_hours_price_amount,
                v.price_amount, p.active AS p_active,
                COALESCE(v.active, 1) AS v_active
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         LEFT JOIN product_variants v ON v.id = ci.variant_id
         WHERE ci.cart_id = ?
         ORDER BY ci.id`,
      )
      .all(cart.id) as any[];
    const lines: CartLine[] = [];
    let total = 0;
    let itemCount = 0;
    for (const r of rows) {
      if (r.p_active !== 1 || r.v_active !== 1) continue; // skip stale items
      let unitPrice = r.variant_id !== null ? r.price_amount : r.fixed_price_amount;
      // After-hours price applies only to fixed-price products that define one.
      if (
        afterHours &&
        r.variant_id === null &&
        r.after_hours_price_amount !== null &&
        r.after_hours_price_amount !== undefined
      ) {
        unitPrice = r.after_hours_price_amount;
      }
      if (unitPrice === null || unitPrice === undefined) continue;
      const lineTotal = unitPrice * r.quantity;
      lines.push({
        cartItemId: r.id,
        productId: r.product_id,
        variantId: r.variant_id ?? null,
        productName: r.product_name,
        variantName: r.variant_name ?? null,
        quantity: r.quantity,
        unitPrice,
        lineTotal,
      });
      total += lineTotal;
      itemCount += r.quantity;
    }
    return { lines, total, itemCount };
  }

  /** Number of live cart lines — drives whether the cart button is shown. */
  lineCount(telegramId: number): number {
    return this.getTotals(telegramId).lines.length;
  }

  /** Remove cart items whose product/variant became inactive or unpriced. */
  pruneInvalidItems(telegramId: number): void {
    const totals = this.getTotals(telegramId);
    const validIds = new Set(totals.lines.map((l) => l.cartItemId));
    const cart = this.get(telegramId);
    if (!cart) return;
    const rows = this.db.query("SELECT id FROM cart_items WHERE cart_id = ?").all(cart.id) as {
      id: number;
    }[];
    for (const r of rows) {
      if (!validIds.has(r.id)) {
        this.db.query("DELETE FROM cart_items WHERE id = ?").run(r.id);
      }
    }
  }

  /**
   * Record the customer's payment choice. Wallet continues to the fulfillment
   * question; card-to-card continues to the receipt step.
   */
  setPaymentMethod(telegramId: number, method: CartPaymentMethod): void {
    this.getOrCreate(telegramId);
    const next = method === "wallet" ? "checkout_fulfillment" : "checkout_receipt";
    this.db
      .query(
        `UPDATE carts SET payment_method = ?, state = ?, updated_at = ? WHERE telegram_id = ?`,
      )
      .run(method, next, nowIso(), telegramId);
  }

  setReceipt(telegramId: number, fileId: string, messageId: number): void {
    this.getOrCreate(telegramId);
    this.db
      .query(
        "UPDATE carts SET receipt_file_id = ?, receipt_message_id = ?, state = 'checkout_fulfillment', updated_at = ? WHERE telegram_id = ?",
      )
      .run(fileId, messageId, nowIso(), telegramId);
  }

  /**
   * Record the fulfillment choice (delivery vs pickup). Moves the cart to
   * `checkout_confirm`, the stage `confirmOrder` accepts — the card path then
   * places the order immediately, the wallet path on the same press.
   */
  setFulfillmentMethod(telegramId: number, method: FulfillmentMethod): void {
    this.getOrCreate(telegramId);
    this.db
      .query(
        "UPDATE carts SET fulfillment_method = ?, state = 'checkout_confirm', updated_at = ? WHERE telegram_id = ?",
      )
      .run(method, nowIso(), telegramId);
  }

  /** Record the requested delivery/pickup time (free text, capped). */
  setFulfillmentTime(telegramId: number, time: string | null): void {
    this.db
      .query("UPDATE carts SET fulfillment_time = ?, updated_at = ? WHERE telegram_id = ?")
      .run(time === null ? null : time.trim().slice(0, 100) || null, nowIso(), telegramId);
  }

  setCheckoutTotal(telegramId: number, total: number): void {
    this.db
      .query("UPDATE carts SET checkout_total_amount = ?, updated_at = ? WHERE telegram_id = ?")
      .run(total, nowIso(), telegramId);
  }

  resetCheckout(telegramId: number): void {
    const cart = this.get(telegramId);
    if (!cart) return;
    this.db
      .query(
        `UPDATE carts SET state = 'browsing', payment_method = NULL, receipt_file_id = NULL,
         receipt_message_id = NULL, delivery_notes = NULL, fulfillment_method = NULL,
         fulfillment_time = NULL, checkout_total_amount = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), cart.id);
  }
}
