/**
 * Mailbox moderation helpers.
 *
 * Every pause/resume of an auth_tokens row must go through these helpers so
 * we never end up with a 'paused' status whose reason/evidence is unknown
 * (which is exactly what happened during the 2026-05-12 phishing campaign
 * cleanup — see migration 0010).
 */

export interface PauseOptions {
  /**
   * Short machine-readable code. Keep stable across calls so we can group
   * paused mailboxes for analysis or automated unpause. Examples:
   *   - 'phishing_2026_05_12'
   *   - 'bounce_rate_high'
   *   - 'spam_complaints'
   *   - 'user_request'
   *   - 'random_id_pattern'
   */
  reason: string

  /**
   * Arbitrary JSON-serialisable evidence object. Whatever the caller
   * inspected when deciding to pause — bounce counts, sample subjects,
   * matched patterns, victim lists. Stored verbatim as JSON in
   * auth_tokens.pause_evidence.
   */
  evidence?: Record<string, unknown>

  /**
   * Override the timestamp written to paused_at. Defaults to "now". Mostly
   * useful for backfills/tests; production callers should let this default.
   */
  at?: Date
}

/**
 * Pause a mailbox with a full audit trail.
 *
 * Sets auth_tokens.status='paused' AND populates paused_at / pause_reason /
 * pause_evidence in the same UPDATE so the three fields can never drift.
 *
 * Idempotent: re-pausing a mailbox refreshes the audit trail with the latest
 * reason/evidence. If you want the original timestamp preserved across
 * re-pauses, the caller should read it first.
 */
export async function pauseMailbox(
  db: D1Database,
  mailbox: string,
  options: PauseOptions,
): Promise<{ paused_at: string; reason: string }> {
  const pausedAt = (options.at ?? new Date()).toISOString()
  const evidenceJson = options.evidence ? JSON.stringify(options.evidence) : null

  const result = await db.prepare(
    `UPDATE auth_tokens
        SET status = 'paused',
            paused_at = ?1,
            pause_reason = ?2,
            pause_evidence = ?3
      WHERE mailbox = ?4`,
  )
    .bind(pausedAt, options.reason, evidenceJson, mailbox)
    .run()

  if (!result.meta.changes) {
    throw new Error(`pauseMailbox: no mailbox matched "${mailbox}"`)
  }

  return { paused_at: pausedAt, reason: options.reason }
}

/**
 * Resume a previously paused mailbox.
 *
 * Clears the audit fields so a future re-pause starts with a fresh record.
 * If you need to keep historical pause records, write them to a separate
 * audit table before calling resume.
 */
export async function resumeMailbox(
  db: D1Database,
  mailbox: string,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE auth_tokens
        SET status = 'active',
            paused_at = NULL,
            pause_reason = NULL,
            pause_evidence = NULL
      WHERE mailbox = ?`,
  )
    .bind(mailbox)
    .run()

  if (!result.meta.changes) {
    throw new Error(`resumeMailbox: no mailbox matched "${mailbox}"`)
  }
}
