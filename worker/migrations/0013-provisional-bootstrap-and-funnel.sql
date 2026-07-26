-- Least-privilege hosted onboarding:
-- - expiring provisional mailbox tokens
-- - idempotent, privacy-preserving bootstrap grants
-- - durable activation funnel events
-- - hashed authentication-failure rate limits

ALTER TABLE auth_tokens ADD COLUMN expires_at TEXT;

-- Historical hosted rows used "full" as a default even though each token was
-- bound to exactly one mailbox. Demote them before the stricter Worker ships.
UPDATE auth_tokens
SET scope = 'mailbox'
WHERE scope IS NULL OR scope = 'full';

CREATE INDEX IF NOT EXISTS idx_auth_tokens_expiry
  ON auth_tokens(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS bootstrap_grants (
  idempotency_hash TEXT PRIMARY KEY,
  principal_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  client_name TEXT NOT NULL DEFAULT 'unknown',
  client_version TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_principal_created
  ON bootstrap_grants(principal_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bootstrap_created
  ON bootstrap_grants(created_at DESC);

CREATE TABLE IF NOT EXISTS bootstrap_quota_buckets (
  bucket_key TEXT PRIMARY KEY,
  bucket_date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_quota_date
  ON bootstrap_quota_buckets(bucket_date);

CREATE TABLE IF NOT EXISTS auth_failure_buckets (
  principal_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_failure_blocked
  ON auth_failure_buckets(blocked_until)
  WHERE blocked_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS funnel_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  client_name TEXT NOT NULL DEFAULT 'unknown',
  client_version TEXT,
  flow TEXT NOT NULL DEFAULT 'unknown',
  outcome TEXT NOT NULL DEFAULT 'success',
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_event_once
  ON funnel_events(event_name, anonymous_id);
CREATE INDEX IF NOT EXISTS idx_funnel_event_time
  ON funnel_events(event_name, created_at DESC);
