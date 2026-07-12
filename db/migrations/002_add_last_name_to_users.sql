-- db/migrations/002_add_last_name_to_users.sql
-- Adds a last_name column to users and backfills it from full_name.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_name text;

-- Backfill last_name from full_name (best-effort):
-- - If full_name is empty -> NULL
-- - If full_name has no spaces -> use full_name as last_name
-- - Otherwise use the last whitespace-delimited token

UPDATE users
SET last_name = CASE
  WHEN full_name IS NULL OR trim(full_name) = '' THEN NULL
  WHEN full_name NOT LIKE '% %' THEN trim(full_name)
  ELSE regexp_replace(trim(full_name), '^.*\s+([^\s]+)$', '\1')
END
WHERE last_name IS NULL;
