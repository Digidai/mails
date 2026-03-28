-- Migration: Add threading columns and email labels table
-- Run: wrangler d1 execute mails --file=worker/migrations/0001-threads-and-labels.sql

ALTER TABLE emails ADD COLUMN thread_id TEXT;
ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
ALTER TABLE emails ADD COLUMN "references" TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id, received_at DESC);

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
