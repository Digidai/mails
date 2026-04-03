-- Migration: SSE events, custom domains, webhook retry, API key scoping
-- Version: 1.8.0

-- Events table for SSE streaming
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_mailbox_time ON events(mailbox, created_at);

-- Custom domains table
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  mx_verified INTEGER NOT NULL DEFAULT 0,
  spf_verified INTEGER NOT NULL DEFAULT 0,
  dkim_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

-- Extend auth_tokens with scope and webhook retry fields
-- scope: 'full' (default) or 'mailbox' (restricted to own mailbox only)
-- webhook_failures: consecutive failure count
-- webhook_status: 'active' (default) or 'failed' (auto-paused after 10 failures)

-- Note: D1 doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS,
-- so we use a safe approach with try/catch in the Worker init.
-- These columns should be added manually or via wrangler d1 execute:
--
-- ALTER TABLE auth_tokens ADD COLUMN scope TEXT DEFAULT 'full';
-- ALTER TABLE auth_tokens ADD COLUMN webhook_failures INTEGER DEFAULT 0;
-- ALTER TABLE auth_tokens ADD COLUMN webhook_status TEXT DEFAULT 'active';

-- Event cleanup: auto-delete events older than 24 hours
-- (handled by a scheduled cron in the Worker, not by SQL trigger)
