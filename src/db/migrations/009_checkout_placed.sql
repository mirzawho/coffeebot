-- Order placed directly at payment/receipt time (no separate confirm step).
--
-- carts.state gains 'checkout_placed': the order row already exists and the
-- customer is picking delivery method + time on the placed order. SQLite
-- cannot alter a CHECK constraint, so the carts table is rebuilt; cart_items
-- is backed up and restored around the swap so its rows survive the DROP
-- (deferred FK enforcement defers the check to COMMIT).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE carts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'browsing'
    CHECK (state IN ('browsing', 'checkout_payment', 'checkout_receipt', 'checkout_fulfillment', 'checkout_confirm', 'checkout_placed')),
  payment_method TEXT
    CHECK (payment_method IS NULL OR payment_method IN ('card_to_card', 'wallet')),
  receipt_file_id TEXT,
  receipt_message_id INTEGER,
  delivery_notes TEXT,
  fulfillment_method TEXT
    CHECK (fulfillment_method IS NULL OR fulfillment_method IN ('delivery', 'pickup')),
  fulfillment_time TEXT,
  checkout_total_amount INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO carts_new (id, telegram_id, state, payment_method, receipt_file_id, receipt_message_id,
                       delivery_notes, fulfillment_method, fulfillment_time, checkout_total_amount,
                       created_at, updated_at)
SELECT id, telegram_id, state, payment_method, receipt_file_id, receipt_message_id,
       delivery_notes, fulfillment_method, fulfillment_time, checkout_total_amount,
       created_at, updated_at
FROM carts;

CREATE TABLE cart_items_backup AS SELECT * FROM cart_items;
DROP TABLE carts;
ALTER TABLE carts_new RENAME TO carts;
INSERT INTO cart_items SELECT * FROM cart_items_backup;
DROP TABLE cart_items_backup;
