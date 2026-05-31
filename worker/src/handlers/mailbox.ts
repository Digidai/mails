import type { Env } from '../types'
import { pauseMailbox, resumeMailbox } from '../lib/moderation'
import { validateWebhookUrl } from './url-safety'

/**
 * GET /api/mailbox — return mailbox info including status
 */
export async function handleMailbox(
  request: Request,
  env: Env,
  mailbox?: string,
): Promise<Response> {
  if (!mailbox) {
    return Response.json({ error: 'Mailbox required' }, { status: 400 })
  }

  if (request.method === 'PATCH') {
    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    // Only act on fields that are explicitly present. Unknown fields are ignored
    // (not treated as "set to null"). This prevents silent data loss.
    const updates: Array<{ col: string; val: string | null }> = []

    if ('webhook_url' in body) {
      const url = body.webhook_url
      if (url === null || url === '') {
        updates.push({ col: 'webhook_url', val: null })
      } else if (typeof url !== 'string') {
        return Response.json(
          { error: 'webhook_url must be a string or null' },
          { status: 400 }
        )
      } else {
        const urlError = validateWebhookUrl(url)
        if (urlError) {
          return Response.json({ error: urlError }, { status: 400 })
        }
        updates.push({ col: 'webhook_url', val: url })
      }
    }

    if (updates.length === 0) {
      // No recognized fields to update — return current state (idempotent no-op)
      const current = await env.DB.prepare(
        'SELECT mailbox, webhook_url FROM auth_tokens WHERE mailbox = ? LIMIT 1'
      ).bind(mailbox).first<{ mailbox: string; webhook_url: string | null }>()
      return Response.json({
        mailbox,
        webhook_url: current?.webhook_url ?? null,
        note: 'No recognized fields in request body (nothing updated)',
      })
    }

    try {
      const setClause = updates.map(u => `${u.col} = ?`).join(', ')
      const values = updates.map(u => u.val)
      await env.DB.prepare(`UPDATE auth_tokens SET ${setClause} WHERE mailbox = ?`)
        .bind(...values, mailbox).run()
    } catch (err) {
      console.error('Failed to update mailbox:', err)
      return Response.json({ error: 'Failed to update mailbox' }, { status: 500 })
    }

    const response: Record<string, unknown> = { mailbox }
    for (const u of updates) response[u.col] = u.val
    return Response.json(response)
  }

  if (request.method === 'DELETE') {
    // Clean up R2 blobs before deleting D1 rows (best-effort, don't block on R2 failures)
    let r2Deleted = 0
    if (env.ATTACHMENTS) {
      try {
        // Delete raw email blobs
        const rawKeys = await env.DB.prepare(
          'SELECT raw_key FROM ingest_log WHERE mailbox = ? AND raw_key IS NOT NULL AND raw_key != ?'
        ).bind(mailbox, '').all<{ raw_key: string }>()
        for (const row of rawKeys.results ?? []) {
          try { await env.ATTACHMENTS.delete(row.raw_key); r2Deleted++ } catch { /* best-effort */ }
        }
        // Delete attachment blobs
        const attKeys = await env.DB.prepare(
          "SELECT storage_key FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?) AND storage_key IS NOT NULL"
        ).bind(mailbox).all<{ storage_key: string }>()
        for (const row of attKeys.results ?? []) {
          try { await env.ATTACHMENTS.delete(row.storage_key); r2Deleted++ } catch { /* best-effort */ }
        }
      } catch (err) {
        console.warn('R2 cleanup during mailbox delete had errors (continuing with D1 delete):', err)
      }
    }

    try {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM email_labels WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)').bind(mailbox),
        env.DB.prepare('DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)').bind(mailbox),
        env.DB.prepare('DELETE FROM emails WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM ingest_log WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM daily_send_counts WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM webhook_routes WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM domains WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM auth_tokens WHERE mailbox = ?').bind(mailbox),
      ])
    } catch (err) {
      console.error('Failed to delete mailbox:', err)
      return Response.json({ error: 'Failed to delete mailbox' }, { status: 500 })
    }
    return Response.json({ ok: true, deleted: mailbox, r2_blobs_deleted: r2Deleted })
  }

  if (request.method === 'GET') {
    // Status column should exist after migrations — query it directly.
    // If it fails, fall back to omitting status rather than lying with "active".
    try {
      const row = await env.DB.prepare(
        'SELECT mailbox, webhook_url, status, created_at FROM auth_tokens WHERE mailbox = ? LIMIT 1'
      ).bind(mailbox).first<{
        mailbox: string
        webhook_url: string | null
        status: string | null
        created_at: string
      }>()

      if (!row) {
        return Response.json({ error: 'Mailbox not found' }, { status: 404 })
      }

      return Response.json({
        mailbox: row.mailbox,
        status: row.status ?? 'active',
        webhook_url: row.webhook_url,
        created_at: row.created_at,
      })
    } catch (err) {
      // status column missing (pre-migration DB) — return without status field
      // rather than hardcoding "active", which would mask real paused mailboxes.
      console.warn('GET /mailbox: status column query failed, falling back:', err)
      const row = await env.DB.prepare(
        'SELECT mailbox, webhook_url, created_at FROM auth_tokens WHERE mailbox = ? LIMIT 1'
      ).bind(mailbox).first<{
        mailbox: string
        webhook_url: string | null
        created_at: string
      }>()

      if (!row) {
        return Response.json({ error: 'Mailbox not found' }, { status: 404 })
      }

      return Response.json({
        mailbox: row.mailbox,
        status: 'unknown',
        webhook_url: row.webhook_url,
        created_at: row.created_at,
        note: 'status column not available in this DB',
      })
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

/**
 * PATCH /api/mailbox/pause — set mailbox status to 'paused'.
 *
 * Optional JSON body: { reason?: string, evidence?: object }.
 * Defaults to reason='user_request' so manual pauses still leave a non-null
 * audit trail.
 */
export async function handleMailboxPause(
  request: Request,
  env: Env,
  mailbox?: string,
): Promise<Response> {
  if (request.method !== 'PATCH') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  if (!mailbox) {
    return Response.json({ error: 'Mailbox required' }, { status: 400 })
  }

  let reason = 'user_request'
  let evidence: Record<string, unknown> | undefined
  if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 0) {
    try {
      const body = await request.json() as { reason?: unknown; evidence?: unknown }
      if (typeof body?.reason === 'string' && body.reason.trim()) reason = body.reason.trim()
      if (body?.evidence && typeof body.evidence === 'object' && !Array.isArray(body.evidence)) {
        evidence = body.evidence as Record<string, unknown>
      }
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
  }

  try {
    const result = await pauseMailbox(env.DB, mailbox, { reason, evidence })
    return Response.json({ mailbox, status: 'paused', reason: result.reason, paused_at: result.paused_at })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to pause mailbox'
    return Response.json({ error: message }, { status: 500 })
  }
}

/**
 * PATCH /api/mailbox/resume — set mailbox status to 'active' and clear the
 * pause audit fields so a future re-pause starts fresh.
 */
export async function handleMailboxResume(
  request: Request,
  env: Env,
  mailbox?: string,
): Promise<Response> {
  if (request.method !== 'PATCH') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  if (!mailbox) {
    return Response.json({ error: 'Mailbox required' }, { status: 400 })
  }

  try {
    await resumeMailbox(env.DB, mailbox)
    return Response.json({ mailbox, status: 'active' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resume mailbox'
    return Response.json({ error: message }, { status: 500 })
  }
}
