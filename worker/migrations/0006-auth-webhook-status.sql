-- Migration: Add webhook_status column to auth_tokens
-- Version: 1.9.1

ALTER TABLE auth_tokens ADD COLUMN webhook_status TEXT DEFAULT 'active';
