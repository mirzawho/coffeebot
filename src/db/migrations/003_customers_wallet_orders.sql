-- Customer profiles, wallet, product emoji/after-hours pricing, order lifecycle,
-- ratings, and AI settings. Compatible with existing databases (additive only).

-- Customer profiles (identity = Telegram user id, same as carts/orders).
CREATE TABLE IF NOT EXISTS customer_profiles (
  telegram_id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Wallet balance (derived from ledger; kept in sync transactionally).
CREATE TABLE IF NOT EXISTS wallets (
  telegram_id INTEGER PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Card-to-card deposit requests reviewed by an administrator.
CREATE TABLE IF NOT EXISTS wallet_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL REFERENCES customer_profiles(telegram_id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  receipt_file_id TEXT,
  receipt_message_id INTEGER,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_wallet_deposits_customer ON wallet_deposits(telegram_id, created_at);
CREATE INDEX idx_wallet_deposits_status ON wallet_deposits(status, created_at);

-- Append-only wallet ledger. Balance = SUM(amount). Never delete rows.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL REFERENCES customer_profiles(telegram_id),
  amount INTEGER NOT NULL CHECK (amount != 0), -- positive credit, negative debit
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'order_payment', 'refund', 'adjustment')),
  ref_type TEXT NOT NULL CHECK (ref_type IN ('deposit', 'order')),
  ref_id INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref_type, ref_id, telegram_id)
);

CREATE INDEX idx_wallet_tx_customer ON wallet_transactions(telegram_id, id);

-- Product emoji + optional after-hours price.
ALTER TABLE products ADD COLUMN emoji TEXT;
ALTER TABLE products ADD COLUMN after_hours_price_amount INTEGER
  CHECK (after_hours_price_amount IS NULL OR after_hours_price_amount >= 0);

-- Order lifecycle: fulfillment + payment method/state, admin actor, timestamps.
ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (fulfillment_status IN ('pending', 'confirmed', 'delivered', 'cancelled'));
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card_to_card'
  CHECK (payment_method IN ('card_to_card', 'wallet'));
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (payment_status IN ('unverified', 'receipt_received', 'paid', 'rejected'));
ALTER TABLE orders ADD COLUMN confirmed_by INTEGER;
ALTER TABLE orders ADD COLUMN confirmed_at TEXT;
ALTER TABLE orders ADD COLUMN delivered_at TEXT;
ALTER TABLE orders ADD COLUMN wallet_debit_tx_id INTEGER REFERENCES wallet_transactions(id);

-- Customer rating after delivery (one per order).
CREATE TABLE IF NOT EXISTS order_ratings (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  telegram_id INTEGER NOT NULL REFERENCES customer_profiles(telegram_id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  feedback TEXT,
  created_at TEXT NOT NULL
);

-- AI settings (persona/toggles) persisted in settings via keys:
--   ai_enabled, ai_persona, ai_max_reply, ai_personalize_greeting,
--   ai_suggest_usual, ai_streaming
-- (no schema change needed; defaults handled in settings.ts)

-- Customer notification toggles:
--   notify_order_confirmed (default 1), ask_delivery_rating (default 1)
