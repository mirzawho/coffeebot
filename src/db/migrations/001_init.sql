CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  fixed_price_amount INTEGER CHECK (fixed_price_amount IS NULL OR fixed_price_amount >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_products_category ON products(category_id, active, sort_order);

CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_variants_product ON product_variants(product_id, active, sort_order);

-- Carts
CREATE TABLE carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'browsing'
    CHECK (state IN ('browsing', 'checkout_receipt', 'checkout_delivery', 'checkout_confirm')),
  receipt_file_id TEXT,
  receipt_message_id INTEGER,
  delivery_notes TEXT,
  checkout_total_amount INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  variant_id INTEGER REFERENCES product_variants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (cart_id, product_id, variant_id)
);

CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);

-- Orders (immutable snapshots of what was ordered)
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_telegram_id INTEGER NOT NULL,
  customer_name TEXT,
  business_date TEXT NOT NULL,
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  currency TEXT NOT NULL,
  receipt_file_id TEXT,
  delivery_notes TEXT,
  status TEXT NOT NULL DEFAULT 'receipt_received_unverified',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_orders_business_date ON orders(business_date);
CREATE INDEX idx_orders_customer ON orders(customer_telegram_id);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  variant_id INTEGER,
  product_name TEXT NOT NULL,
  variant_name TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_amount INTEGER NOT NULL CHECK (unit_price_amount >= 0),
  line_total_amount INTEGER NOT NULL CHECK (line_total_amount >= 0)
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- Settings (payment, report config, currency, etc.)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE business_hours (
  -- 0=Sunday .. 6=Saturday (JS weekday convention)
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Daily report runs — one row per business date attempt
CREATE TABLE report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped_empty')),
  sent_at TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (business_date)
);

-- Notification delivery queue with idempotency
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('daily_report', 'order_update')),
  recipient_id INTEGER NOT NULL,
  ref_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  payload TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref_key, recipient_id)
);

CREATE INDEX idx_notifications_due ON notifications(status, next_attempt_at);

-- Checkout callback dedup: one-shot action tokens
CREATE TABLE action_tokens (
  token TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  created_at TEXT NOT NULL
);
