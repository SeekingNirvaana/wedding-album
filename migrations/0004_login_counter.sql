-- How many times each number has signed in, and a daily limit for non-admins
ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
INSERT INTO settings (key, value) VALUES ('login_daily_cap', '5') ON CONFLICT(key) DO NOTHING;
