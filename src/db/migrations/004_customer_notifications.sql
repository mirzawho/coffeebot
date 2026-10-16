-- Customer-facing notification kinds (order confirmed / delivered / deposit
-- outcome) reuse the same durable queue; the CHECK constraint is recreated
-- with the new kinds. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE IF NOT EXISTS notifications_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('daily_report', 'order_update', 'customer_notice')),
  recipient_id INTEGER NOT NULL,
  ref_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  payload TEXT NOT NULL,
  error TEXT,
  claimed_at TEXT,
  delivered_chunks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref_key, recipient_id)
);

INSERT INTO notifications_new (id, kind, recipient_id, ref_key, status, attempts, next_attempt_at, payload, error, claimed_at, delivered_chunks, created_at)
SELECT id, kind, recipient_id, ref_key, status, attempts, next_attempt_at, payload, error, claimed_at, delivered_chunks, created_at FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, next_attempt_at);
