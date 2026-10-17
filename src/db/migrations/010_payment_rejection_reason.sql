-- Reason an admin gave when rejecting a card-to-card receipt. NULL until a
-- rejection is recorded (bot keyboard or admin panel).
ALTER TABLE orders ADD COLUMN rejection_reason TEXT;
