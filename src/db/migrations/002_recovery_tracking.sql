-- Crash-recovery tracking for notification/report delivery (claim timestamps
-- + per-chunk progress cursor). See notifications.ts / reports.ts.
ALTER TABLE notifications ADD COLUMN claimed_at TEXT;
ALTER TABLE notifications ADD COLUMN delivered_chunks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_runs ADD COLUMN claimed_at TEXT;
