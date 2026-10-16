import type { Db } from "../db/database";
import { nowIso, tx } from "../db/database";

/**
 * Customer ratings and "the usual" (repeated-order) suggestions.
 * Recommendations are computed ONLY from the customer's own persisted orders.
 */

export interface Rating {
  orderId: number;
  telegramId: number;
  rating: number;
  feedback: string | null;
  createdAt: string;
}

export interface UsualItem {
  productId: number | null;
  variantId: number | null;
  productName: string;
  variantName: string | null;
  timesOrdered: number;
  avgQuantity: number;
}

export interface UsualSuggestion {
  /** The dominant repeated combination, if one is clear. */
  primary: UsualItem[];
  /** Other frequently ordered items (up to 3), when a primary isn't obvious. */
  alternates: UsualItem[];
  ordersAnalyzed: number;
}

const MIN_ORDERS_FOR_USUAL = 2;
const MIN_TIMES_ORDERED = 2;
const MAX_USUAL_ITEMS = 5;

export class LoyaltyService {
  constructor(private readonly db: Db) {}

  // ---------- ratings ----------

  getRatingForOrder(orderId: number): Rating | null {
    const r = this.db.query("SELECT * FROM order_ratings WHERE order_id = ?").get(orderId) as any;
    if (!r) return null;
    return {
      orderId: r.order_id,
      telegramId: r.telegram_id,
      rating: r.rating,
      feedback: r.feedback ?? null,
      createdAt: r.created_at,
    };
  }

  /** Idempotent: a second rating for the same order is rejected (edit supported). */
  saveRating(
    orderId: number,
    telegramId: number,
    rating: number,
    feedback?: string | null,
  ): { ok: true; rating: Rating } | { ok: false; error: string } {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, error: "امتیاز باید بین ۱ تا ۵ باشد" };
    }
    const fb = String(feedback ?? "").trim().slice(0, 500) || null;
    const now = nowIso();
    // Existing customers may have orders but no profile yet; preserve FK integrity.
    this.db
      .query(
        "INSERT INTO customer_profiles (telegram_id, first_name, created_at, updated_at) VALUES (?, '', ?, ?) ON CONFLICT(telegram_id) DO NOTHING",
      )
      .run(telegramId, now, now);
    // Upsert so a customer can revise their rating, but only for their own order.
    const res = this.db
      .query(
        `INSERT INTO order_ratings (order_id, telegram_id, rating, feedback, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET rating = excluded.rating, feedback = excluded.feedback,
           created_at = excluded.created_at
         WHERE order_ratings.telegram_id = excluded.telegram_id`,
      )
      .run(orderId, telegramId, rating, fb, now);
    const saved = this.getRatingForOrder(orderId);
    if (!saved || saved.telegramId !== telegramId) {
      return { ok: false, error: "امکان ثبت امتیاز نیست" };
    }
    void res;
    return { ok: true, rating: saved };
  }

  // ---------- the usual ----------

  /**
   * Summarize a customer's repeated orders. Only the customer's own history is
   * consulted; items with a matching (product, variant) pair are aggregated.
   */
  usualFor(telegramId: number, limitOrders = 20): UsualSuggestion {
    const rows = this.db
      .query(
        `SELECT oi.product_id, oi.variant_id, oi.product_name, oi.variant_name, oi.quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_telegram_id = ?
         ORDER BY o.id DESC LIMIT ?`,
      )
      .all(telegramId, limitOrders * 10) as any[];
    if (rows.length === 0) return { primary: [], alternates: [], ordersAnalyzed: 0 };

    // Group by (product, variant) → times ordered + total quantity.
    const key = (r: any) => `${r.product_id ?? "x"}:${r.variant_id ?? "x"}`;
    const agg = new Map<
      string,
      { item: UsualItem; totalQty: number }
    >();
    for (const r of rows) {
      const k = key(r);
      const entry = agg.get(k);
      if (entry) {
        entry.item.timesOrdered += 1;
        entry.totalQty += r.quantity;
      } else {
        agg.set(k, {
          item: {
            productId: r.product_id ?? null,
            variantId: r.variant_id ?? null,
            productName: r.product_name,
            variantName: r.variant_name ?? null,
            timesOrdered: 1,
            avgQuantity: r.quantity,
          },
          totalQty: r.quantity,
        });
      }
    }
    for (const { item, totalQty } of agg.values()) {
      item.avgQuantity = Math.max(1, Math.round(totalQty / item.timesOrdered));
    }
    const frequent = [...agg.values()]
      .map((v) => v.item)
      .filter((i) => i.timesOrdered >= MIN_TIMES_ORDERED)
      .sort((a, b) => b.timesOrdered - a.timesOrdered)
      .slice(0, MAX_USUAL_ITEMS);

    if (frequent.length === 0) {
      return { primary: [], alternates: [], ordersAnalyzed: Math.min(rows.length, limitOrders) };
    }
    // A "clear" usual = a single dominant item, or a small coherent set.
    const primary = frequent.slice(0, Math.min(3, frequent.length));
    const alternates = frequent.slice(primary.length, primary.length + 3);
    return { primary, alternates, ordersAnalyzed: Math.min(rows.length, limitOrders) };
  }

  /** A customer's recent ratings (admin customer-detail view). */
  ratingsForCustomer(telegramId: number, limit = 10): (Rating & { orderNumber: string | null })[] {
    const rows = this.db
      .query(
        `SELECT r.*, o.order_number FROM order_ratings r
         LEFT JOIN orders o ON o.id = r.order_id
         WHERE r.telegram_id = ? ORDER BY r.order_id DESC LIMIT ?`,
      )
      .all(telegramId, limit) as any[];
    return rows.map((r) => ({
      orderId: r.order_id,
      telegramId: r.telegram_id,
      rating: r.rating,
      feedback: r.feedback ?? null,
      createdAt: r.created_at,
      orderNumber: r.order_number ?? null,
    }));
  }
}
