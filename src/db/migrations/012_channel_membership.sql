-- Telegram channel membership enforcement (additive; safe for existing installs).
--
-- Last known verification result per customer. The `channel` column records
-- which channel the result was fetched for, so a result obtained for a previous
-- channel configuration is never mistaken for the current one. `unknown` means
-- the Telegram API could not be queried (permissions/network) — NOT that the
-- user is not a member.

CREATE TABLE IF NOT EXISTS channel_membership (
  telegram_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('member', 'not_member', 'unknown')),
  channel TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- Settings keys (seeded with defaults in database.ts):
--   channel_membership_enabled ("0"/"1", default "0")
--   channel_membership_channel ("@username"; empty = not configured)
--   channel_membership_message (optional custom join prompt; empty = default)
