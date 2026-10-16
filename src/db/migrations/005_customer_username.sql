-- Telegram identity for customers (username is not part of the profile-edit
-- flow; it is captured from the validated sender at order time so the admin
-- panel can link to the customer's chat).
ALTER TABLE customer_profiles ADD COLUMN username TEXT;
