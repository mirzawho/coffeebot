-- Referral system (additive; safe for existing installs).
--
-- Each customer gets one short, shareable referral code (normalized uppercase,
-- stored on the profile with a UNIQUE index). A customer can have at most one
-- current referrer (referrals.telegram_id is the PRIMARY KEY). referral_events
-- is an append-only audit trail of set/change/remove actions.

ALTER TABLE customer_profiles ADD COLUMN referral_code TEXT;

CREATE UNIQUE INDEX idx_customer_profiles_referral_code
  ON customer_profiles(referral_code);

-- Current attribution: one row per referred customer.
CREATE TABLE IF NOT EXISTS referrals (
  telegram_id INTEGER PRIMARY KEY REFERENCES customer_profiles(telegram_id),
  referred_by INTEGER NOT NULL REFERENCES customer_profiles(telegram_id),
  referral_code_used TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('link', 'manual', 'admin')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_referrals_referred_by ON referrals(referred_by);

-- Append-only audit of relationship changes (who changed what, when).
CREATE TABLE IF NOT EXISTS referral_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  previous_referred_by INTEGER,
  new_referred_by INTEGER,
  action TEXT NOT NULL CHECK (action IN ('set', 'change', 'remove')),
  actor INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_referral_events_telegram ON referral_events(telegram_id, id);

-- Settings key (seeded empty in database.ts defaults / set by the bot on start):
--   bot_username (used to build referral deep links in the admin panel)
