-- Migration: switch FTS5 tokenizer to trigram for CJK support
-- Version: 1.9.2
--
-- Problem: unicode61 tokenizer splits on word boundaries, but CJK (Chinese,
-- Japanese, Korean) has no spaces between words. Everything becomes one
-- unmatchable token, so queries like `?query=验证码` return 0 results.
--
-- Fix: use trigram tokenizer which indexes character 3-grams. This works
-- for ALL languages (including CJK and alphabetic), at the cost of a
-- slightly larger index. Case-insensitive via `case_sensitive 0`.
--
-- Steps:
-- 1. Drop old FTS5 table and triggers
-- 2. Recreate with trigram tokenizer
-- 3. Rebuild index from content table

DROP TRIGGER IF EXISTS emails_fts_ai;
DROP TRIGGER IF EXISTS emails_fts_au;
DROP TRIGGER IF EXISTS emails_fts_ad;
DROP TABLE IF EXISTS emails_fts;

CREATE VIRTUAL TABLE emails_fts USING fts5(
  subject, from_name, from_address, body_text, code,
  content='emails',
  content_rowid='rowid',
  tokenize='trigram case_sensitive 0'
);

-- Rebuild from existing data
INSERT INTO emails_fts(emails_fts) VALUES('rebuild');

-- Recreate triggers
CREATE TRIGGER emails_fts_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, from_name, from_address, body_text, code)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.code);
END;

CREATE TRIGGER emails_fts_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, body_text, code)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.code);
  INSERT INTO emails_fts(rowid, subject, from_name, from_address, body_text, code)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.code);
END;

CREATE TRIGGER emails_fts_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, body_text, code)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.code);
END;
