-- Migration: Add webhook_failures column to auth_tokens
-- Version: 1.9.1

ALTER TABLE auth_tokens ADD COLUMN webhook_failures INTEGER DEFAULT 0;
