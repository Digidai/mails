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
  // Try In-Reply-To first (most specific)
  if (inReplyTo) {
    const existing = await db
      .prepare('SELECT thread_id FROM emails WHERE message_id = ? AND mailbox = ? AND thread_id IS NOT NULL LIMIT 1')
      .bind(inReplyTo, mailbox)
      .first<{ thread_id: string }>()
    if (existing) return existing.thread_id
  }

  // Try References chain (walk from latest to earliest)
  if (references) {
    const refs = references.trim().split(/\s+/).reverse()
    for (const ref of refs) {
      const existing = await db
        .prepare('SELECT thread_id FROM emails WHERE message_id = ? AND mailbox = ? AND thread_id IS NOT NULL LIMIT 1')
        .bind(ref, mailbox)
        .first<{ thread_id: string }>()
      if (existing) return existing.thread_id
    }
  }

  // No existing thread found — generate new thread_id
  return crypto.randomUUID()
}
