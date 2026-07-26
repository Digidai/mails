-- Privacy-preserving first-party website attribution.
-- This intentionally excludes raw IPs, referrer URLs, query strings,
-- mailboxes, email addresses, API keys, user agents, and page contents.

CREATE TABLE IF NOT EXISTS growth_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL
    CHECK (event_name IN ('page_view', 'cta_click', 'copy_command', 'claim_intent')),
  anonymous_id TEXT NOT NULL,
  event_day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'direct',
  medium TEXT NOT NULL DEFAULT 'none',
  campaign TEXT NOT NULL DEFAULT 'none',
  page_path TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  UNIQUE(event_name, anonymous_id, event_day, page_path, target)
);

CREATE INDEX IF NOT EXISTS idx_growth_event_time
  ON growth_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_source_time
  ON growth_events(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_page_time
  ON growth_events(page_path, created_at DESC);

CREATE TABLE IF NOT EXISTS growth_quota_buckets (
  bucket_key TEXT PRIMARY KEY,
  bucket_date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_growth_quota_date
  ON growth_quota_buckets(bucket_date);
