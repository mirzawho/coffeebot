import { describe, test, expect, beforeEach, setSystemTime } from "bun:test";
import { openDatabase } from "../src/db/database";
import type { Db } from "../src/db/database";
import { MenuService } from "../src/services/menu";
import { CartService } from "../src/services/cart";
import { OrdersService } from "../src/services/orders";
import { BusinessHoursService } from "../src/services/business-hours";
import { CustomersService } from "../src/services/customers";
import { updatePaymentSettings } from "../src/services/settings";
import { formatOrderNumber } from "../src/utils/ids";

let db: Db;
let menu: MenuService;
let cart: CartService;
let orders: OrdersService;
let bh: BusinessHoursService;
let waterId: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  menu = new MenuService(db);
  bh = new BusinessHoursService(db, "Asia/Tehran");
  cart = new CartService(db);
  orders = new OrdersService(db, bh);
  updatePaymentSettings(db, { cardNumber: "603799", cardholderName: "Ali", currency: "تومان" });
  const cat = menu.createCategory({ name: "نوشیدنی" });
  waterId = menu.createProduct({ categoryId: cat.id, name: "آب", fixedPriceAmount: 15000 }).id;
});

function seedCart(userId: number, qty = 2): void {
  cart.addItem(userId, waterId, null, qty);
}

/** Advance a seeded cart from the receipt stage to confirm (fulfillment asked). */
function toConfirm(userId: number, method: "delivery" | "pickup" = "pickup"): void {
  cart.setFulfillmentMethod(userId, method);
}

describe("checkout flow", () => {
  test("happy path: order created with snapshot and receipt", () => {
    seedCart(1, 3);
    const co = orders.startCheckout(1);
    expect(co.ok).toBe(true);
    if (!co.ok) return;
    expect(co.total).toBe(45000);
    // Checkout opens on the payment-method picker, not straight on the receipt.
    expect(cart.get(1)?.state).toBe("checkout_payment");
    expect(cart.get(1)?.paymentMethod).toBeNull();

    const pick = orders.choosePaymentMethod(1, "card_to_card");
    expect(pick.ok).toBe(true);
    expect(cart.get(1)?.state).toBe("checkout_receipt");
    expect(cart.get(1)?.paymentMethod).toBe("card_to_card");

    expect(orders.attachReceipt(1, "file-xyz", 77).ok).toBe(true);
    expect(cart.get(1)?.state).toBe("checkout_fulfillment");

    toConfirm(1, "delivery");
    cart.setFulfillmentTime(1, "ساعت ۵ عصر");
    expect(cart.get(1)?.state).toBe("checkout_confirm");

    const conf = orders.confirmOrder(1, "Ali");
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;
    expect(conf.order.orderNumber).toMatch(/^CN-\d{8}-\d{4}$/);
    expect(conf.order.totalAmount).toBe(45000);
    expect(conf.order.receiptFileId).toBe("file-xyz");
    expect(conf.order.deliveryNotes).toBeNull();
    expect(conf.order.fulfillmentMethod).toBe("delivery");
    expect(conf.order.deliveryTime).toBe("ساعت ۵ عصر");
    expect(conf.order.status).toBe("receipt_received_unverified");
    expect(conf.order.paymentMethod).toBe("card_to_card");
    expect(conf.order.paymentStatus).toBe("receipt_received");
    expect(conf.order.items.length).toBe(1);
    expect(conf.order.items[0]!.unitPrice).toBe(15000);
    expect(conf.order.items[0]!.quantity).toBe(3);
    // Cart finalized
    expect(cart.getTotals(1).lines.length).toBe(0);
    expect(cart.get(1)?.state).toBe("browsing");
    expect(cart.get(1)?.paymentMethod).toBeNull();
  });

  test("placeOrderAfterReceipt creates the order immediately with pickup/now defaults", () => {
    seedCart(1, 2); // 30,000
    orders.startCheckout(1);
    orders.choosePaymentMethod(1, "card_to_card");
    const placed = orders.placeOrderAfterReceipt(1, "receipt-file", 42, "Ali");
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.order.paymentMethod).toBe("card_to_card");
    expect(placed.order.paymentStatus).toBe("receipt_received");
    expect(placed.order.receiptFileId).toBe("receipt-file");
    // Defaults applied at placement — no extra confirm step.
    expect(placed.order.fulfillmentMethod).toBe("pickup");
    expect(placed.order.deliveryTime).toBeNull();
    expect(placed.order.totalAmount).toBe(30000);
    expect(cart.get(1)?.state).toBe("browsing");
    expect(cart.getTotals(1).lines.length).toBe(0);
    // The receipt is inside the editable window.
    expect(orders.editableOrderFor(1)?.id).toBe(placed.order.id);
  });

  test("updateFulfillment edits a pending order but refuses after confirmation", () => {
    seedCart(1, 1);
    orders.startCheckout(1);
    const placed = orders.placeOrderAfterReceipt(1, "f", 1);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    // Delivery needs a saved address.
    new CustomersService(db).saveProfile(1, { fullName: "مشتری", address: "تهران" });

    const edited = orders.updateFulfillment(placed.order.id, 1, {
      method: "delivery",
      time: "فردا",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.order.fulfillmentMethod).toBe("delivery");
    expect(edited.order.deliveryTime).toBe("فردا");

    // Another customer cannot touch it.
    expect(orders.updateFulfillment(placed.order.id, 2, { method: "pickup" }).ok).toBe(false);

    // Once the café confirms it, the customer can no longer edit.
    orders.markConfirmed(placed.order.id, 777);
    expect(orders.updateFulfillment(placed.order.id, 1, { method: "pickup" }).ok).toBe(false);
  });

  test("delivery edit is refused without a saved address", () => {
    seedCart(1, 1);
    orders.startCheckout(1);
    const placed = orders.placeOrderAfterReceipt(1, "f", 1);
    if (!placed.ok) throw new Error("place failed");
    const r = orders.updateFulfillment(placed.order.id, 1, { method: "delivery" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("آدرس");
  });

  test("a screenshot sent on the payment screen implicitly selects card-to-card", () => {
    seedCart(1, 2);
    orders.startCheckout(1);
    expect(cart.get(1)?.state).toBe("checkout_payment");
    expect(orders.attachReceipt(1, "f", 1).ok).toBe(true);
    expect(cart.get(1)?.paymentMethod).toBe("card_to_card");
    expect(cart.get(1)?.state).toBe("checkout_fulfillment");
  });

  test("wallet payment skips the receipt stage and charges at confirm", () => {
    const dep = new CustomersService(db).createDeposit(1, 50000);
    if (!dep.ok) throw new Error("deposit failed");
    new CustomersService(db).approveDeposit(dep.deposit.id, 777);
    seedCart(1, 2); // 30,000
    orders.startCheckout(1);
    const pick = orders.choosePaymentMethod(1, "wallet");
    expect(pick.ok).toBe(true);
    // Wallet skips the receipt but still asks the fulfillment question.
    expect(cart.get(1)?.state).toBe("checkout_fulfillment");
    expect(cart.get(1)?.paymentMethod).toBe("wallet");
    cart.setFulfillmentMethod(1, "pickup");

    const conf = orders.confirmOrder(1, "Ali");
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;
    expect(conf.order.paymentMethod).toBe("wallet");
    expect(conf.order.paymentStatus).toBe("paid");
    expect(conf.order.receiptFileId).toBeNull();
    expect(new CustomersService(db).getBalance(1)).toBe(20000);
  });

  test("wallet choice is refused when the balance does not cover the order", () => {
    seedCart(1, 2); // 30,000 with an empty wallet
    orders.startCheckout(1);
    const pick = orders.choosePaymentMethod(1, "wallet");
    expect(pick.ok).toBe(false);
    // The customer stays on the picker and can still pay by card.
    expect(cart.get(1)?.state).toBe("checkout_payment");
    expect(cart.get(1)?.paymentMethod).toBeNull();
    expect(orders.choosePaymentMethod(1, "card_to_card").ok).toBe(true);
  });

  test("payment choice is only accepted at the payment stage", () => {
    seedCart(1, 1);
    expect(orders.choosePaymentMethod(1, "wallet").ok).toBe(false); // still browsing
    orders.startCheckout(1);
    orders.choosePaymentMethod(1, "card_to_card");
    expect(orders.choosePaymentMethod(1, "wallet").ok).toBe(false); // already chosen
  });

  test("card-to-card confirm without a receipt is refused", () => {
    seedCart(1, 1);
    orders.startCheckout(1);
    orders.choosePaymentMethod(1, "card_to_card");
    // Still on the receipt stage — confirm must refuse before any order exists.
    const conf = orders.confirmOrder(1, "Ali");
    expect(conf.ok).toBe(false);
    if (conf.ok) return;
    expect(conf.reason).toBe("error");
    expect(orders.listForCustomer(1).length).toBe(0);
  });

  test("the displayed total matches the charged amount after hours", () => {
    menu.updateProduct(waterId, { afterHoursPriceAmount: 20000 });
    seedCart(1, 2);
    // The cafe is closed on Fridays, so the after-hours price applies. Pin the
    // clock — the service reads the real time, so a hardcoded date would only
    // pass on the matching weekday.
    setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const friday = new Date("2026-10-16T12:00:00Z");
      expect(bh.isOpenAt(friday)).toBe(false);
      const shown = orders.getPaymentInstructions(1);
      expect(shown.total).toBe(40000); // 2 × 20,000, not 2 × 15,000
      const co = orders.startCheckout(1);
      expect(co.ok).toBe(true);
      if (!co.ok) return;
      expect(co.total).toBe(shown.total);
    } finally {
      setSystemTime();
    }
  });

  test("price change mid-checkout returns price_changed then re-confirm succeeds", () => {
    seedCart(1, 2);
    const co = orders.startCheckout(1);
    expect(co.ok).toBe(true);
    orders.attachReceipt(1, "f", 1);
    cart.setFulfillmentMethod(1, "pickup");
    menu.updateProduct(waterId, { fixedPriceAmount: 20000 });

    const first = orders.confirmOrder(1);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.reason).toBe("price_changed");
    if (first.reason !== "price_changed") return;
    expect(first.total).toBe(40000);

    const second = orders.confirmOrder(1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.order.totalAmount).toBe(40000);
  });

  test("empty cart cannot checkout", () => {
    const co = orders.startCheckout(5);
    expect(co.ok).toBe(false);
  });

  test("confirm without receipt stage fails", () => {
    seedCart(1);
    orders.startCheckout(1);
    // Skip attachReceipt — state is checkout_receipt, confirm should fail.
    const conf = orders.confirmOrder(1);
    expect(conf.ok).toBe(false);
  });

  test("cancel resets checkout", () => {
    seedCart(1);
    orders.startCheckout(1);
    cart.resetCheckout(1);
    expect(cart.get(1)?.state).toBe("browsing");
    // Items remain, checkout fields cleared
    expect(cart.getTotals(1).lines.length).toBe(1);
    expect(cart.get(1)?.receiptFileId).toBeNull();
  });

  test("order items are snapshots — menu edits do not rewrite history", () => {
    seedCart(1, 2);
    orders.startCheckout(1);
    orders.attachReceipt(1, "f", 1);
    cart.setFulfillmentMethod(1, "pickup");
    const conf = orders.confirmOrder(1);
    expect(conf.ok).toBe(true);
    if (!conf.ok) return;

    menu.updateProduct(waterId, { name: "آب معدنی جدید", fixedPriceAmount: 99999 });
    const loaded = orders.loadOrder(conf.order.id)!;
    expect(loaded.items[0]!.productName).toBe("آب");
    expect(loaded.items[0]!.unitPrice).toBe(15000);
    expect(loaded.totalAmount).toBe(30000);
  });

  test("order number is unique per business date sequence", () => {
    expect(formatOrderNumber("2026-10-12", 1)).toBe("CN-20261012-0001");
    seedCart(1);
    orders.startCheckout(1);
    orders.attachReceipt(1, "f", 1);
    cart.setFulfillmentMethod(1, "pickup");
    const c1 = orders.confirmOrder(1);
    expect(c1.ok).toBe(true);

    seedCart(2);
    orders.startCheckout(2);
    orders.attachReceipt(2, "f2", 2);
    cart.setFulfillmentMethod(2, "pickup");
    const c2 = orders.confirmOrder(2);
    expect(c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;
    expect(c2.order.orderNumber).not.toBe(c1.order.orderNumber);
    expect(c2.order.orderNumber.endsWith("0002")).toBe(true);
    expect(c2.order.businessDate).toBe(c1.order.businessDate);
  });

  test("receipt required before the order can be placed", () => {
    seedCart(1);
    orders.startCheckout(1);
    // Still on the payment picker — nothing may place an order yet.
    expect(orders.confirmOrder(1).ok).toBe(false);
    expect(orders.listForCustomer(1).length).toBe(0);
  });
});

describe("payment configuration guard", () => {
  test("checkout is refused when neither card nor wallet can pay", () => {
    db.query("UPDATE settings SET value = '' WHERE key = 'card_number'").run();
    seedCart(1);
    const co = orders.startCheckout(1);
    expect(co.ok).toBe(false);
    if (co.ok) return;
    expect(co.reason).toBe("payment_unconfigured");
    // The cart must not enter any checkout state — no fake payment flow.
    expect(cart.get(1)?.state).toBe("browsing");
    expect(cart.get(1)?.checkoutTotalAmount).toBeNull();
    expect(cart.getTotals(1).lines.length).toBe(1);
  });

  test("checkout proceeds with no card when the wallet covers the order", () => {
    db.query("UPDATE settings SET value = '' WHERE key = 'card_number'").run();
    const customers = new CustomersService(db);
    const dep = customers.createDeposit(1, 50000);
    if (!dep.ok) throw new Error("deposit failed");
    customers.approveDeposit(dep.deposit.id, 777);
    seedCart(1, 1); // 15,000
    const co = orders.startCheckout(1);
    expect(co.ok).toBe(true);
    if (!co.ok) return;
    expect(co.walletBalance).toBe(50000);
    // Card-to-card is not offered without a configured card number.
    expect(orders.choosePaymentMethod(1, "card_to_card").ok).toBe(false);
    expect(orders.choosePaymentMethod(1, "wallet").ok).toBe(true);
  });
});

describe("latestOrderFor", () => {
  test("returns null for a customer without orders", () => {
    expect(orders.latestOrderFor(42)).toBeNull();
  });

  test("returns the most recent order for the customer only", () => {
    seedCart(1, 1);
    orders.startCheckout(1);
    orders.attachReceipt(1, "f1", 1);
    cart.setFulfillmentMethod(1, "pickup");
    const first = orders.confirmOrder(1, "A");
    expect(first.ok).toBe(true);

    seedCart(1, 2);
    orders.startCheckout(1);
    orders.attachReceipt(1, "f2", 2);
    cart.setFulfillmentMethod(1, "pickup");
    const second = orders.confirmOrder(1, "A");
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const latest = orders.latestOrderFor(1);
    expect(latest?.orderNumber).toBe(second.order.orderNumber);
    // Another customer sees nothing.
    expect(orders.latestOrderFor(2)).toBeNull();
  });
});
