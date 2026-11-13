-- 005_add_user_title.sql
-- Add job title column to users table to support organizational hierarchy alongside system RBAC roles

ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
CREATE INDEX IF NOT EXISTS idx_users_title ON users (title);

