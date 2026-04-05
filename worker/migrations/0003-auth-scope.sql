-- Migration: Add scope column to auth_tokens and status column for pause/resume
-- Version: 1.8.1

ALTER TABLE auth_tokens ADD COLUMN scope TEXT DEFAULT 'full';
ALTER TABLE auth_tokens ADD COLUMN status TEXT DEFAULT 'active';
