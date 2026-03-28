/**
 * Resolve the thread_id for an incoming email by looking up
 * In-Reply-To and References headers against existing emails.
 */
export async function resolveThreadId(
  inReplyTo: string | null,
  references: string | null,
  messageId: string | null,
  db: D1Database,
  mailbox: string
): Promise<string> {
  // Normalize: treat empty strings as null
  const replyTo = inReplyTo?.trim() || null
  // Normalize references: unfold RFC 2822 header folding (CRLF + whitespace)
  const refsRaw = references?.replace(/\r?\n[ \t]+/g, ' ').trim() || null

  // Try In-Reply-To first (most specific)
  if (replyTo) {
    const existing = await db
      .prepare('SELECT thread_id FROM emails WHERE message_id = ? AND mailbox = ? AND thread_id IS NOT NULL LIMIT 1')
      .bind(replyTo, mailbox)
      .first<{ thread_id: string }>()
    if (existing) return existing.thread_id
  }

  // Try References chain — batch lookup to avoid N+1 queries
  if (refsRaw) {
    const refs = refsRaw.split(/\s+/).filter(Boolean)
    if (refs.length > 0) {
      // Cap at 20 refs to prevent abuse / excessively long headers
      const capped = refs.slice(-20)
      const placeholders = capped.map(() => '?').join(', ')
      const rows = await db
        .prepare(
          `SELECT message_id, thread_id FROM emails WHERE message_id IN (${placeholders}) AND mailbox = ? AND thread_id IS NOT NULL`
        )
        .bind(...capped, mailbox)
        .all<{ message_id: string; thread_id: string }>()

      if (rows.results && rows.results.length > 0) {
        // Build lookup map and return thread_id of the latest reference (walk from end)
        const lookup = new Map(rows.results.map((r) => [r.message_id, r.thread_id]))
        for (const ref of capped.reverse()) {
          const tid = lookup.get(ref)
          if (tid) return tid
        }
      }
    }
  }

  // No existing thread found — generate new thread_id
  return crypto.randomUUID()
}
