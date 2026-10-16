-- Full-name customer profiles + delivery/pickup fulfillment at checkout.
--
-- customer_profiles gains full_name (the bot now treats the name as one field,
-- not first/last) and an optional delivery address. first_name keeps its NOT
-- NULL contract: it mirrors full_name so existing readers keep working.
-- orders/carts gain the fulfillment choice (delivery vs pickup) and the
-- requested delivery time.

ALTER TABLE customer_profiles ADD COLUMN full_name TEXT;
ALTER TABLE customer_profiles ADD COLUMN address TEXT;

-- Backfill: full_name = first_name [+ ' ' + last_name].
UPDATE customer_profiles SET full_name = TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
  WHERE full_name IS NULL;

ALTER TABLE orders ADD COLUMN fulfillment_method TEXT NOT NULL DEFAULT 'pickup'
  CHECK (fulfillment_method IN ('delivery', 'pickup'));
ALTER TABLE orders ADD COLUMN delivery_time TEXT;

-- SQLite cannot alter a CHECK constraint: rebuild carts, preserving rows.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE carts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'browsing'
    CHECK (state IN ('browsing', 'checkout_payment', 'checkout_receipt', 'checkout_fulfillment', 'checkout_confirm')),
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
                       delivery_notes, checkout_total_amount, created_at, updated_at)
SELECT id, telegram_id, state, payment_method, receipt_file_id, receipt_message_id,
       delivery_notes, checkout_total_amount, created_at, updated_at
FROM carts;

CREATE TABLE cart_items_backup AS SELECT * FROM cart_items;
DROP TABLE carts;
ALTER TABLE carts_new RENAME TO carts;
INSERT INTO cart_items SELECT * FROM cart_items_backup;
DROP TABLE cart_items_backup;

-- Legacy 'checkout_delivery' state rows (pre-fulfillment-question carts) map
-- onto the new confirm stage; the bot re-asks fulfillment on the next checkout.
UPDATE carts SET state = 'checkout_confirm' WHERE state = 'checkout_delivery';
