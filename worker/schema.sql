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
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  raw_storage_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
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
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_filename ON attachments(filename);

-- FTS5 full-text search index (D1 supports FTS5)
-- tokenize='unicode61 remove_diacritics 2' handles case folding automatically
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, from_name, from_address, body_text, code,
  content='emails',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Auto-sync FTS index on email insert
CREATE TRIGGER IF NOT EXISTS emails_fts_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, from_name, from_address, body_text, code)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.code);
END;

-- Auto-sync FTS index on email delete
CREATE TRIGGER IF NOT EXISTS emails_fts_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, body_text, code)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.code);
END;

-- Auth tokens for mailbox isolation (optional — table may not exist in older deployments)
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  webhook_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_mailbox ON auth_tokens(mailbox);
