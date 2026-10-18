-- The Telegram message a notification was delivered as. Review decisions made
-- later (bot keyboard or admin panel) edit this message in place — e.g.
-- rewriting the receipt caption after approval — so the message id must be
-- remembered at delivery time.
ALTER TABLE notifications ADD COLUMN notification_id INTEGER;
