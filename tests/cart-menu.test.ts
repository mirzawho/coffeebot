import { describe, test, expect, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { MAX_ITEM_QUANTITY } from "../src/utils/ids";

let db: Db;
let menu: MenuService;
let cart: CartService;
let waterId: number; // fixed price
let espressoId: number; // variants
let singleId: number;
let doubleId: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  menu = new MenuService(db);
  cart = new CartService(db);
  const cat = menu.createCategory({ name: "نوشیدنی" });
  waterId = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 }).id;
  espressoId = menu.createProduct({ categoryId: cat.id, name: "اسپرسو" }).id;
  singleId = menu.createVariant({ productId: espressoId, name: "تک‌شات", priceAmount: 50000 }).id;
  doubleId = menu.createVariant({ productId: espressoId, name: "دبل", priceAmount: 75000 }).id;
});

describe("menu pricing", () => {
  test("fixed price product without variants", () => {
    const r = menu.resolvePrice(waterId, null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unitPrice).toBe(15000);
  });

  test("variant product requires valid active variant", () => {
    expect(menu.resolvePrice(espressoId, null).ok).toBe(false);
    expect(menu.resolvePrice(espressoId, 99999).ok).toBe(false);
    const r = menu.resolvePrice(espressoId, doubleId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unitPrice).toBe(75000);
  });

  test("inactive product not orderable", () => {
    menu.updateProduct(waterId, { active: false });
    expect(menu.resolvePrice(waterId, null).ok).toBe(false);
  });

  test("inactive variant not orderable", () => {
    menu.updateVariant(singleId, { active: false });
    expect(menu.resolvePrice(espressoId, singleId).ok).toBe(false);
    expect(menu.resolvePrice(espressoId, doubleId).ok).toBe(true);
  });

  test("invalid product id", () => {
    expect(menu.resolvePrice(424242, null).ok).toBe(false);
  });
});

describe("cart operations", () => {
  test("add fixed price and variant items; totals computed server-side", () => {
    expect(cart.addItem(1, waterId, null, 1).ok).toBe(true);
    expect(cart.addItem(1, espressoId, doubleId, 2).ok).toBe(true);
    const t = cart.getTotals(1);
    expect(t.total).toBe(15000 + 75000 * 2);
    expect(t.itemCount).toBe(3);
  });

  test("adding variant product without variant is rejected", () => {
    const r = cart.addItem(1, espressoId, null, 1);
    expect(r.ok).toBe(false);
  });

  test("quantity limits enforced", () => {
    expect(cart.addItem(1, waterId, null, 0).ok).toBe(false);
    expect(cart.addItem(1, waterId, null, -1).ok).toBe(false);
    expect(cart.addItem(1, waterId, null, MAX_ITEM_QUANTITY + 1).ok).toBe(false);
    expect(cart.addItem(1, waterId, null, MAX_ITEM_QUANTITY).ok).toBe(true);
    // Exceeding via increments
    const line = cart.getTotals(1).lines[0]!;
    expect(cart.changeQty(1, line.cartItemId, 1).ok).toBe(false);
  });

  test("same product+variant accumulates; different variants are separate lines", () => {
    cart.addItem(1, espressoId, singleId, 1);
    cart.addItem(1, espressoId, singleId, 1);
    cart.addItem(1, espressoId, doubleId, 1);
    const t = cart.getTotals(1);
    expect(t.lines.length).toBe(2);
    expect(t.lines.find((l) => l.variantId === singleId)?.quantity).toBe(2);
  });

  test("decrease to zero removes the line", () => {
    cart.addItem(1, waterId, null, 1);
    const line = cart.getTotals(1).lines[0]!;
    expect(cart.changeQty(1, line.cartItemId, -1).ok).toBe(true);
    expect(cart.getTotals(1).lines.length).toBe(0);
  });

  test("remove item", () => {
    cart.addItem(1, waterId, null, 2);
    const line = cart.getTotals(1).lines[0]!;
    expect(cart.removeItem(1, line.cartItemId).ok).toBe(true);
    expect(cart.getTotals(1).lines.length).toBe(0);
    // Second remove fails (stale)
    expect(cart.removeItem(1, line.cartItemId).ok).toBe(false);
  });

  test("clear cart resets state and items", () => {
    cart.addItem(1, waterId, null, 2);
    cart.setState(1, "checkout_receipt");
    cart.clear(1);
    expect(cart.getTotals(1).lines.length).toBe(0);
    expect(cart.get(1)?.state).toBe("browsing");
  });

  test("cannot modify cart while in checkout", () => {
    cart.addItem(1, waterId, null, 1);
    cart.setState(1, "checkout_receipt");
    expect(cart.addItem(1, waterId, null, 1).ok).toBe(false);
    const line = cart.getTotals(1).lines[0]!;
    expect(cart.changeQty(1, line.cartItemId, 1).ok).toBe(false);
    expect(cart.removeItem(1, line.cartItemId).ok).toBe(false);
  });

  test("inactive product is pruned from totals", () => {
    cart.addItem(1, waterId, null, 1);
    menu.updateProduct(waterId, { active: false });
    expect(cart.getTotals(1).lines.length).toBe(0);
    cart.pruneInvalidItems(1);
    const rows = db.query("SELECT COUNT(*) AS c FROM cart_items").get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("cart setQty (absolute quantity)", () => {
  test("sets an absolute quantity and recalculates totals server-side", () => {
    cart.addItem(1, waterId, null, 1);
    expect(cart.setQty(1, waterId, null, 5).ok).toBe(true);
    const totals = cart.getTotals(1);
    expect(totals.lines[0]!.quantity).toBe(5);
    expect(totals.lines[0]!.lineTotal).toBe(75000);
    expect(totals.total).toBe(75000);
  });

  test("quantity 0 removes the line", () => {
    cart.addItem(1, waterId, null, 2);
    expect(cart.setQty(1, waterId, null, 0).ok).toBe(true);
    expect(cart.getTotals(1).lines.length).toBe(0);
  });

  test("rejects out-of-range and non-integer quantities", () => {
    cart.addItem(1, waterId, null, 1);
    expect(cart.setQty(1, waterId, null, -1).ok).toBe(false);
    expect(cart.setQty(1, waterId, null, 1.5).ok).toBe(false);
    expect(cart.setQty(1, waterId, null, MAX_ITEM_QUANTITY + 1).ok).toBe(false);
    expect(cart.getTotals(1).lines[0]!.quantity).toBe(1);
  });

  test("fails for products not in the cart", () => {
    expect(cart.setQty(1, waterId, null, 2).ok).toBe(false);
  });

  test("revalidates availability — unavailable product cannot be set", () => {
    cart.addItem(1, waterId, null, 1);
    menu.updateProduct(waterId, { active: false });
    expect(cart.setQty(1, waterId, null, 3).ok).toBe(false);
  });

  test("setQty is scoped to the requesting customer", () => {
    cart.addItem(1, waterId, null, 2);
    cart.addItem(2, waterId, null, 2);
    expect(cart.setQty(2, waterId, null, 1).ok).toBe(true);
    expect(cart.getTotals(2).lines[0]!.quantity).toBe(1);
    // Customer 1's line is untouched.
    expect(cart.getTotals(1).lines[0]!.quantity).toBe(2);
  });

  test("cannot setQty while checkout is in progress", () => {
    cart.addItem(1, waterId, null, 1);
    cart.setState(1, "checkout_receipt");
    expect(cart.setQty(1, waterId, null, 3).ok).toBe(false);
  });
});
