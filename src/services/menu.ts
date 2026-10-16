import type { Db } from "../db/database";
import { nowIso } from "../db/database";
import { assertAmount } from "../utils/money";

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface Variant {
  id: number;
  productId: number;
  name: string;
  priceAmount: number;
  sortOrder: number;
  active: boolean;
}

export interface Product {
  id: number;
  categoryId: number;
  name: string;
  description: string;
  imagePath: string | null;
  fixedPriceAmount: number | null;
  /** Optional after-hours price; null = use the regular price. */
  afterHoursPriceAmount: number | null;
  /** Optional display emoji (admin-configured); null = none. */
  emoji: string | null;
  sortOrder: number;
  active: boolean;
  variants: Variant[];
}

export function cleanName(raw: unknown, label: string): string {
  const name = String(raw ?? "").trim();
  if (!name) throw new Error(`${label} نمی‌تواند خالی باشد`);
  if (name.length > 120) throw new Error(`${label} بیش از حد مجاز طولانی است`);
  return name;
}

/** Optional single emoji (or short emoji cluster); null/empty clears it. */
export function cleanEmoji(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Emoji clusters + variation selectors + ZWJ; allow up to 3 clusters.
  const emojiRe = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u200D\uFE0F\u20E3]){1,12}$/u;
  if (!emojiRe.test(s) || s.length > 16) throw new Error("ایموجی نامعتبر است");
  return s;
}

export class MenuService {
  constructor(private readonly db: Db) {}

  // ---- categories ----

  listCategories(includeInactive = false): Category[] {
    const sql = includeInactive
      ? "SELECT id, name, sort_order, active FROM categories ORDER BY sort_order, id"
      : "SELECT id, name, sort_order, active FROM categories WHERE active = 1 ORDER BY sort_order, id";
    return (this.db.query(sql).all() as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      sortOrder: r.sort_order,
      active: r.active === 1,
    }));
  }

  createCategory(input: { name: string; sortOrder?: number; active?: boolean }): Category {
    const name = cleanName(input.name, "نام دسته‌بندی");
    const sortOrder = Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 999;
    const active = input.active === false ? 0 : 1;
    const res = this.db
      .query(
        "INSERT INTO categories (name, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(name, sortOrder, active, nowIso(), nowIso());
    return { id: Number(res.lastInsertRowid), name, sortOrder, active: active === 1 };
  }

  updateCategory(
    id: number,
    input: { name?: string; sortOrder?: number; active?: boolean },
  ): Category {
    const existing = this.db.query("SELECT * FROM categories WHERE id = ?").get(id) as any;
    if (!existing) throw new Error("دسته‌بندی یافت نشد");
    const name = input.name !== undefined ? cleanName(input.name, "نام دسته‌بندی") : existing.name;
    const sortOrder = input.sortOrder !== undefined && Number.isInteger(input.sortOrder)
      ? Number(input.sortOrder)
      : existing.sort_order;
    const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;
    this.db
      .query("UPDATE categories SET name = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?")
      .run(name, sortOrder, active, nowIso(), id);
    return { id, name, sortOrder, active: active === 1 };
  }

  /** Deletion is refused while products reference the category; deactivate instead. */
  deleteCategory(id: number): void {
    const count = (
      this.db.query("SELECT COUNT(*) AS c FROM products WHERE category_id = ?").get(id) as {
        c: number;
      }
    ).c;
    if (count > 0) {
      throw new Error("این دسته‌بندی دارای محصول است؛ ابتده محصولات را منتقل یا غیرفعال کنید");
    }
    this.db.query("DELETE FROM categories WHERE id = ?").run(id);
  }

  // ---- products / variants ----

  private variantRow(r: any): Variant {
    return {
      id: r.id,
      productId: r.product_id,
      name: r.name,
      priceAmount: r.price_amount,
      sortOrder: r.sort_order,
      active: r.active === 1,
    };
  }

  private productRow(r: any, variants: Variant[]): Product {
    return {
      id: r.id,
      categoryId: r.category_id,
      name: r.name,
      description: r.description ?? "",
      imagePath: r.image_path ?? null,
      fixedPriceAmount: r.fixed_price_amount ?? null,
      afterHoursPriceAmount: r.after_hours_price_amount ?? null,
      emoji: r.emoji ?? null,
      sortOrder: r.sort_order,
      active: r.active === 1,
      variants,
    };
  }

  getVariants(productId: number, includeInactive = false): Variant[] {
    const sql = includeInactive
      ? "SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id"
      : "SELECT * FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY sort_order, id";
    return (this.db.query(sql).all(productId) as any[]).map((r) => this.variantRow(r));
  }

  getProduct(id: number, includeInactive = true): Product | null {
    const r = this.db.query("SELECT * FROM products WHERE id = ?").get(id) as any;
    if (!r) return null;
    return this.productRow(r, this.getVariants(id, includeInactive));
  }

  listProducts(categoryId?: number, includeInactive = false): Product[] {
    let sql = "SELECT * FROM products";
    const params: any[] = [];
    if (!includeInactive) sql += " WHERE active = 1";
    if (categoryId !== undefined) {
      sql += includeInactive ? " WHERE category_id = ?" : " AND category_id = ?";
      params.push(categoryId);
    }
    sql += " ORDER BY sort_order, id";
    const rows = this.db.query(sql).all(...params) as any[];
    return rows.map((r) => this.productRow(r, this.getVariants(r.id, includeInactive)));
  }

  createProduct(input: {
    categoryId: number;
    name: string;
    description?: string;
    fixedPriceAmount?: number | null;
    afterHoursPriceAmount?: number | null;
    emoji?: string | null;
    imagePath?: string | null;
    sortOrder?: number;
    active?: boolean;
  }): Product {
    const cat = this.db.query("SELECT id FROM categories WHERE id = ?").get(input.categoryId);
    if (!cat) throw new Error("دسته‌بندی یافت نشد");
    const name = cleanName(input.name, "نام محصول");
    const description = String(input.description ?? "").trim();
    if (description.length > 2000) throw new Error("توضیحات محصول بیش از حد مجاز طولانی است");
    let fixed: number | null = null;
    if (input.fixedPriceAmount !== undefined && input.fixedPriceAmount !== null) {
      assertAmount(input.fixedPriceAmount, "قیمت");
      fixed = input.fixedPriceAmount;
    }
    let afterHours: number | null = null;
    if (input.afterHoursPriceAmount !== undefined && input.afterHoursPriceAmount !== null) {
      assertAmount(input.afterHoursPriceAmount, "قیمت خارج از ساعت کاری");
      afterHours = input.afterHoursPriceAmount;
    }
    const emoji = cleanEmoji(input.emoji);
    const sortOrder = Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 999;
    const active = input.active === false ? 0 : 1;
    const imagePath = input.imagePath ? String(input.imagePath) : null;
    const res = this.db
      .query(
        `INSERT INTO products (category_id, name, description, image_path, fixed_price_amount, after_hours_price_amount, emoji, sort_order, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.categoryId,
        name,
        description,
        imagePath,
        fixed,
        afterHours,
        emoji,
        sortOrder,
        active,
        nowIso(),
        nowIso(),
      );
    return this.getProduct(Number(res.lastInsertRowid))!;
  }

  updateProduct(
    id: number,
    input: Partial<{
      categoryId: number;
      name: string;
      description: string;
      fixedPriceAmount: number | null;
      afterHoursPriceAmount: number | null;
      emoji: string | null;
      imagePath: string | null;
      sortOrder: number;
      active: boolean;
    }>,
  ): Product {
    const existing = this.db.query("SELECT * FROM products WHERE id = ?").get(id) as any;
    if (!existing) throw new Error("محصول یافت نشد");
    if (input.categoryId !== undefined) {
      const cat = this.db.query("SELECT id FROM categories WHERE id = ?").get(input.categoryId);
      if (!cat) throw new Error("دسته‌بندی یافت نشد");
    }
    const name = input.name !== undefined ? cleanName(input.name, "نام محصول") : existing.name;
    const description =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    let fixed = existing.fixed_price_amount;
    if (input.fixedPriceAmount !== undefined) {
      if (input.fixedPriceAmount === null) fixed = null;
      else {
        assertAmount(input.fixedPriceAmount, "قیمت");
        fixed = input.fixedPriceAmount;
      }
    }
    let afterHours = existing.after_hours_price_amount ?? null;
    if (input.afterHoursPriceAmount !== undefined) {
      if (input.afterHoursPriceAmount === null) afterHours = null;
      else {
        assertAmount(input.afterHoursPriceAmount, "قیمت خارج از ساعت کاری");
        afterHours = input.afterHoursPriceAmount;
      }
    }
    const emoji = input.emoji !== undefined ? cleanEmoji(input.emoji) : existing.emoji ?? null;
    const sortOrder =
      input.sortOrder !== undefined && Number.isInteger(input.sortOrder)
        ? Number(input.sortOrder)
        : existing.sort_order;
    const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;
    const imagePath =
      input.imagePath !== undefined
        ? input.imagePath
          ? String(input.imagePath)
          : null
        : existing.image_path;
    this.db
      .query(
        `UPDATE products SET category_id = ?, name = ?, description = ?, image_path = ?,
         fixed_price_amount = ?, after_hours_price_amount = ?, emoji = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.categoryId ?? existing.category_id,
        name,
        description,
        imagePath,
        fixed,
        afterHours,
        emoji,
        sortOrder,
        active,
        nowIso(),
        id,
      );
    return this.getProduct(id)!;
  }

  /**
   * Hard-delete only if no order history references the product.
   * Otherwise the caller should deactivate.
   */
  deleteProduct(id: number): void {
    const refs = (
      this.db.query("SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?").get(id) as {
        c: number;
      }
    ).c;
    if (refs > 0) {
      throw new Error("این محصول در سفارش‌ها استفاده شده است؛ فقط غیرفعال‌سازی مجاز است");
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM product_variants WHERE product_id = ?").run(id);
      this.db.query("DELETE FROM cart_items WHERE product_id = ?").run(id);
      this.db.query("DELETE FROM products WHERE id = ?").run(id);
    })();
  }

  createVariant(input: {
    productId: number;
    name: string;
    priceAmount: number;
    sortOrder?: number;
    active?: boolean;
  }): Variant {
    const product = this.db.query("SELECT id FROM products WHERE id = ?").get(input.productId);
    if (!product) throw new Error("محصول یافت نشد");
    const name = cleanName(input.name, "نام واریانت");
    assertAmount(input.priceAmount, "قیمت واریانت");
    const sortOrder = Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 999;
    const active = input.active === false ? 0 : 1;
    const res = this.db
      .query(
        `INSERT INTO product_variants (product_id, name, price_amount, sort_order, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.productId, name, input.priceAmount, sortOrder, active, nowIso(), nowIso());
    return this.variantRow(
      this.db.query("SELECT * FROM product_variants WHERE id = ?").get(Number(res.lastInsertRowid)),
    );
  }

  updateVariant(
    id: number,
    input: Partial<{ name: string; priceAmount: number; sortOrder: number; active: boolean }>,
  ): Variant {
    const existing = this.db.query("SELECT * FROM product_variants WHERE id = ?").get(id) as any;
    if (!existing) throw new Error("واریانت یافت نشد");
    const name = input.name !== undefined ? cleanName(input.name, "نام واریانت") : existing.name;
    let price = existing.price_amount;
    if (input.priceAmount !== undefined) {
      assertAmount(input.priceAmount, "قیمت واریانت");
      price = input.priceAmount;
    }
    const sortOrder =
      input.sortOrder !== undefined && Number.isInteger(input.sortOrder)
        ? Number(input.sortOrder)
        : existing.sort_order;
    const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;
    this.db
      .query(
        "UPDATE product_variants SET name = ?, price_amount = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, price, sortOrder, active, nowIso(), id);
    return this.variantRow(this.db.query("SELECT * FROM product_variants WHERE id = ?").get(id));
  }

  deleteVariant(id: number): void {
    const refs = (
      this.db.query("SELECT COUNT(*) AS c FROM order_items WHERE variant_id = ?").get(id) as {
        c: number;
      }
    ).c;
    if (refs > 0) {
      throw new Error("این واریانت در سفارش‌ها استفاده شده است؛ فقط غیرفعال‌سازی مجاز است");
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM cart_items WHERE variant_id = ?").run(id);
      this.db.query("DELETE FROM product_variants WHERE id = ?").run(id);
    })();
  }

  /** Active catalog for customer bot + AI matching. */
  activeCatalog(): { categories: Category[]; products: Product[] } {
    const categories = this.listCategories(false);
    const products = this.listProducts(undefined, false).filter((p) =>
      categories.some((c) => c.id === p.categoryId),
    );
    return { categories, products };
  }

  /**
   * Full catalog for the AI, including unavailable products (so it can answer
   * «ناموجود» questions). `active` on each product already reflects combined
   * product+category availability; validation rejects mutations on inactive ones.
   */
  aiCatalog(): { categories: Category[]; products: Product[] } {
    const categories = this.listCategories(true);
    const activeCatIds = new Set(categories.filter((c) => c.active).map((c) => c.id));
    const products = this.listProducts(undefined, true).map((p) =>
      activeCatIds.has(p.categoryId) ? p : { ...p, active: false },
    );
    return { categories, products };
  }

  /** Resolve price of a product+variant for ordering. Null if not orderable. */
  resolvePrice(
    productId: number,
    variantId: number | null,
  ): { ok: true; product: Product; variant: Variant | null; unitPrice: number } | { ok: false; error: string } {
    const product = this.getProduct(productId, false);
    if (!product || !product.active) return { ok: false, error: "محصول در منو موجود نیست" };
    const activeVariants = product.variants.filter((v) => v.active);
    if (activeVariants.length > 0) {
      const variant = activeVariants.find((v) => v.id === variantId);
      if (!variant) return { ok: false, error: "واریانت انتخاب‌شده نامعتبر یا غیرفعال است" };
      return { ok: true, product, variant, unitPrice: variant.priceAmount };
    }
    if (variantId !== null) {
      return { ok: false, error: "این محصول واریانت ندارد" };
    }
    if (product.fixedPriceAmount === null) {
      return { ok: false, error: "قیمت این محصول تنظیم نشده است" };
    }
    return { ok: true, product, variant: null, unitPrice: product.fixedPriceAmount };
  }

  /**
   * Effective fixed price for the given time: the after-hours price applies
   * only outside business hours AND when configured; otherwise the regular
   * price. Zero is a valid configured price (distinct from "not configured").
   */
  priceFor(product: Product, afterHours: boolean): number | null {
    if (afterHours && product.afterHoursPriceAmount !== null) return product.afterHoursPriceAmount;
    return product.fixedPriceAmount;
  }
}
