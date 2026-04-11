CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT DEFAULT '',
  to_address TEXT NOT NULL,
  subject TEXT DEFAULT '',
  body_text TEXT DEFAULT '',
  body_html TEXT DEFAULT '',
  code TEXT,
  headers TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  message_id TEXT,
  thread_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  raw_storage_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued', 'delivered', 'bounced', 'complained', 'delivery_delayed')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  content_disposition TEXT,
  content_id TEXT,
  mime_part_index INTEGER NOT NULL,
  text_content TEXT DEFAULT '',
  text_extraction_status TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction);
CREATE INDEX IF NOT EXISTS idx_emails_has_attachments ON emails(mailbox, has_attachments, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_filename ON attachments(filename);

-- FTS5 full-text search index (D1 supports FTS5)
-- Uses trigram tokenizer for CJK (Chinese/Japanese/Korean) support.
-- unicode61 splits on word boundaries and fails on CJK where there are no spaces.
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, from_name, from_address, body_text, code,
  content='emails',
  content_rowid='rowid',
  tokenize='trigram case_sensitive 0'
);

-- Auto-sync FTS index on email insert
CREATE TRIGGER IF NOT EXISTS emails_fts_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, from_name, from_address, body_text, code)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.code);
END;

-- Auto-sync FTS index on email update
CREATE TRIGGER IF NOT EXISTS emails_fts_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, body_text, code)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.code);
  INSERT INTO emails_fts(rowid, subject, from_name, from_address, body_text, code)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.code);
END;

-- Auto-sync FTS index on email delete
CREATE TRIGGER IF NOT EXISTS emails_fts_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, body_text, code)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.code);
END;

-- Auth tokens for mailbox isolation (full schema for fresh deployments)
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  webhook_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  scope TEXT DEFAULT 'full',
  status TEXT DEFAULT 'active',
  webhook_failures INTEGER DEFAULT 0,
  webhook_status TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_mailbox ON auth_tokens(mailbox);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_mailbox_unique ON auth_tokens(mailbox);

-- Claim sessions (temporary, 10-min expiry)
CREATE TABLE IF NOT EXISTS claim_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  api_key TEXT,
  mailbox TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_sessions_status ON claim_sessions(status, expires_at);

-- Email labels for auto-classification
CREATE TABLE IF NOT EXISTS email_labels (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_labels_email_id ON email_labels(email_id);
CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_labels_unique ON email_labels(email_id, label);

-- Suppression list for bounced/complained recipients
CREATE TABLE IF NOT EXISTS suppression_list (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Per-mailbox daily send rate limits
CREATE TABLE IF NOT EXISTS daily_send_counts (
  mailbox TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mailbox, date)
);

-- Events table for SSE streaming
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_mailbox_time ON events(mailbox, created_at);

-- Ingest log for raw-first email persistence (tracks ingestion state)
CREATE TABLE IF NOT EXISTS ingest_log (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsed', 'failed')),
  error_message TEXT,
  from_address TEXT,
  to_address TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  email_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_log_status ON ingest_log(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ingest_log_mailbox ON ingest_log(mailbox, created_at DESC);

-- Inbound idempotency: prevent duplicate emails on replay/redelivery
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_mailbox_message_id ON emails(mailbox, message_id);

-- Webhook routes for per-label routing (smart email routing)
CREATE TABLE IF NOT EXISTS webhook_routes (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  label TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_routes_unique ON webhook_routes(mailbox, label);
CREATE INDEX IF NOT EXISTS idx_webhook_routes_mailbox ON webhook_routes(mailbox);

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
