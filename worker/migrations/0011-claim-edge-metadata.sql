-- Capture richer edge metadata for every claim_session so future rate-limit
-- and abuse rules can branch on country / ASN / verified-human signals,
-- not just IP. All fields are free on Cloudflare Workers/Pages — request.cf
-- exposes country/asn/asOrganization, and Turnstile siteverify gives a
-- boolean human-verification result.
--
-- Existing rows stay NULL/0. The application populates these on every
-- new /v1/claim/start (country/asn/as_org) and every /v1/claim/confirm
-- (turnstile_verified).
ALTER TABLE claim_sessions ADD COLUMN country TEXT;
ALTER TABLE claim_sessions ADD COLUMN asn INTEGER;
ALTER TABLE claim_sessions ADD COLUMN as_org TEXT;
ALTER TABLE claim_sessions ADD COLUMN turnstile_verified INTEGER NOT NULL DEFAULT 0;

-- Partial index — only sessions with an ASN matter for "ban this datacenter" queries
CREATE INDEX IF NOT EXISTS idx_claim_sessions_asn ON claim_sessions(asn) WHERE asn IS NOT NULL;
