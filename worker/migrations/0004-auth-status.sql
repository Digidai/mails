-- Migration: Add status column to auth_tokens (for pause/resume)
-- Version: 1.9.1
-- Note: Each ALTER must be in its own file because D1 runs SQL files as a
-- single batch. If the first ALTER fails (e.g., column already exists),
-- subsequent ALTERs in the same file are not executed.

ALTER TABLE auth_tokens ADD COLUMN status TEXT DEFAULT 'active';
