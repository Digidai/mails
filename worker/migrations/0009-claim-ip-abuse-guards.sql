-- Store claim source metadata so hosted deployments can rate-limit mailbox
-- creation by client IP instead of relying only on coarse global limits.
ALTER TABLE claim_sessions ADD COLUMN ip_address TEXT;
ALTER TABLE claim_sessions ADD COLUMN user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_claim_sessions_ip_created ON claim_sessions(ip_address, created_at);
CREATE INDEX IF NOT EXISTS idx_claim_sessions_created_at ON claim_sessions(created_at);
