-- Add an audit trail for mailbox pauses so future moderation decisions
-- (manual review, automated unpause, abuse reports) can reconstruct WHY a
-- mailbox was paused, WHEN, and on WHAT evidence.
--
-- Before this migration the only signal was status='paused' on auth_tokens,
-- which made it impossible to distinguish a phishing-abuse pause from a
-- user-initiated pause or a high-bounce auto-pause.
ALTER TABLE auth_tokens ADD COLUMN paused_at TEXT;
ALTER TABLE auth_tokens ADD COLUMN pause_reason TEXT;
ALTER TABLE auth_tokens ADD COLUMN pause_evidence TEXT;

-- Backfill the 2026-05-12 phishing campaign accounts that were paused
-- before this schema existed. The 117 random 8-char mailboxes sent ~395
-- templated phishing emails to ~331 AU/CA recipients.
UPDATE auth_tokens
SET paused_at = '2026-05-13T08:00:00Z',
    pause_reason = 'phishing_2026_05_12',
    pause_evidence = json_object(
      'pattern', '8char_random_id',
      'campaign_day', '2026-05-12',
      'note', 'mass-registered, sent templated phishing to AU/CA addresses'
    )
WHERE status = 'paused'
  AND date(created_at) IN ('2026-05-12','2026-05-13')
  AND mailbox GLOB '????????@mails0.com'
  AND paused_at IS NULL;

-- Same campaign, named precursor accounts created the day before
UPDATE auth_tokens
SET paused_at = '2026-05-13T08:00:00Z',
    pause_reason = 'phishing_2026_05_12_precursor',
    pause_evidence = json_object(
      'pattern', 'named_precursor',
      'campaign_day', '2026-05-11',
      'related_to', 'phishing_2026_05_12'
    )
WHERE mailbox IN ('linkt@mails0.com','linkts@mails0.com','mlskk@mails0.com','manols@mails0.com')
  AND paused_at IS NULL;
