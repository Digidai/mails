-- Send-warmup window for new mailboxes — defends against the
-- 2026-05-12-style attack where a fresh mailbox immediately becomes a
-- phishing fan-out. NULL = no warmup (legacy / explicitly unlocked).
-- ISO timestamp in the future = /api/send rejected until that moment.
-- Inbound and read paths are NOT gated — the "AI agent registers SaaS
-- and grabs OTP from inbox" use case still works on a brand-new mailbox.
ALTER TABLE auth_tokens ADD COLUMN send_unlocks_at TEXT;

-- Existing mailboxes (status='active' or 'paused' as of this migration)
-- stay unlocked. Only new claims start warm. We do NOT backfill — the
-- intent is "tighten the screw on new abuse" not "lock out the
-- existing user base."

CREATE INDEX IF NOT EXISTS idx_auth_tokens_warmup
  ON auth_tokens(send_unlocks_at)
  WHERE send_unlocks_at IS NOT NULL;
