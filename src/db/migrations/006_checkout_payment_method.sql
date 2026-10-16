-- Payment method selection at checkout + admin payment review.
--
-- carts.state gains 'checkout_payment' (the customer picks wallet vs
-- card-to-card before any receipt is requested) and carts.payment_method
-- remembers that choice. SQLite cannot alter a CHECK constraint, so the carts
-- table is rebuilt; cart_items is backed up and restored around the swap so
-- its rows survive the DROP (deferred FK enforcement defers the check to
-- COMMIT, by which point the new carts table exists again).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE carts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'browsing'
    CHECK (state IN ('browsing', 'checkout_payment', 'checkout_receipt', 'checkout_delivery', 'checkout_confirm')),
  payment_method TEXT
    CHECK (payment_method IS NULL OR payment_method IN ('card_to_card', 'wallet')),
  receipt_file_id TEXT,
  receipt_message_id INTEGER,
  delivery_notes TEXT,
  checkout_total_amount INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO carts_new (id, telegram_id, state, receipt_file_id, receipt_message_id,
                       delivery_notes, checkout_total_amount, created_at, updated_at)
SELECT id, telegram_id, state, receipt_file_id, receipt_message_id,
       delivery_notes, checkout_total_amount, created_at, updated_at
FROM carts;

CREATE TABLE cart_items_backup AS SELECT * FROM cart_items;
DROP TABLE carts;
ALTER TABLE carts_new RENAME TO carts;
INSERT INTO cart_items SELECT * FROM cart_items_backup;
DROP TABLE cart_items_backup;

-- Admin payment review audit (who approved/rejected the payment and when).
ALTER TABLE orders ADD COLUMN payment_reviewed_by INTEGER;
ALTER TABLE orders ADD COLUMN payment_reviewed_at TEXT;
