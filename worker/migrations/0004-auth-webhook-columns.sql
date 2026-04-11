-- Migration: Add webhook_failures and webhook_status columns to auth_tokens
-- Version: 1.9.1
-- These columns are used by webhook.ts for auto-pause after 10 consecutive failures.
-- They were defined in the webhook handler but never fully migrated.

ALTER TABLE auth_tokens ADD COLUMN webhook_failures INTEGER DEFAULT 0;
ALTER TABLE auth_tokens ADD COLUMN webhook_status TEXT DEFAULT 'active';
