-- Order refunds + customer bank cards (additive; safe for existing installs).
--
-- refunds: one row per refund operation. Item-level refunds reference an
-- order_item and carry the refunded quantity; a full-order refund is expressed
-- as one refund row per remaining item (created in a single transaction), so
-- every amount stays traceable to a purchased line.
--
-- Settlement:
--   wallet — credited from the wallet ledger in the same transaction that
--            inserts the row (status starts at 'completed', wallet_tx_id set);
--   card   — recorded as payable to the customer's registered card snapshot
--            (status starts at 'pending'); an admin confirms completion after
--            making the transfer manually. No bank integration exists.
--
-- Idempotency: idempotency_key is UNIQUE; wallet ledger credits additionally
-- use ref_id = refunds.id under the existing
-- UNIQUE(kind, ref_type, ref_id, telegram_id) ledger index, so each refund can
-- credit the wallet at most once.
--
-- Counts toward an order's remaining refundable balance: statuses
-- 'pending' + 'completed' (a pending card refund reserves the amount; a
-- cancelled one frees it again).

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  customer_telegram_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  settlement_method TEXT NOT NULL CHECK (settlement_method IN ('wallet', 'card')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  reason_code TEXT,
  reason_text TEXT,
  card_last4 TEXT,
  card_masked TEXT,
  cardholder_name TEXT,
  wallet_tx_id INTEGER REFERENCES wallet_transactions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  completed_by INTEGER,
  completed_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);

CREATE INDEX idx_refunds_order ON refunds(order_id, status);
CREATE INDEX idx_refunds_item ON refunds(order_item_id, status);
CREATE INDEX idx_refunds_status ON refunds(status, created_at);
CREATE INDEX idx_refunds_customer ON refunds(customer_telegram_id, created_at);

-- One registered bank card per customer. card_number is the normalized 16-digit
-- form (Persian/Arabic digits folded, separators stripped). Never returned in
-- full by any API — callers mask before display.
CREATE TABLE IF NOT EXISTS customer_cards (
  telegram_id INTEGER PRIMARY KEY REFERENCES customer_profiles(telegram_id),
  card_number TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
