import type { Env } from '../types'

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
    let body: { webhook_url?: string | null }
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    try {
      await env.DB.prepare('UPDATE auth_tokens SET webhook_url = ? WHERE mailbox = ?')
        .bind(body.webhook_url ?? null, mailbox).run()
    } catch (err) {
      console.error('Failed to update mailbox:', err)
      return Response.json({ error: 'Failed to update mailbox' }, { status: 500 })
    }
    return Response.json({ mailbox, webhook_url: body.webhook_url ?? null })
  }

  if (request.method === 'DELETE') {
    try {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM email_labels WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)').bind(mailbox),
        env.DB.prepare('DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)').bind(mailbox),
        env.DB.prepare('DELETE FROM emails WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM ingest_log WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM daily_send_counts WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM webhook_routes WHERE mailbox = ?').bind(mailbox),
        env.DB.prepare('DELETE FROM auth_tokens WHERE mailbox = ?').bind(mailbox),
      ])
    } catch (err) {
      console.error('Failed to delete mailbox:', err)
      return Response.json({ error: 'Failed to delete mailbox' }, { status: 500 })
    }
    return Response.json({ ok: true, deleted: mailbox })
  }

  if (request.method === 'GET') {
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
    } catch {
      // status column may not exist — fallback
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
        status: 'active',
        webhook_url: row.webhook_url,
        created_at: row.created_at,
      })
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

/**
 * PATCH /api/mailbox/pause — set mailbox status to 'paused'
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

  try {
    await env.DB.prepare(
      "UPDATE auth_tokens SET status = 'paused' WHERE mailbox = ?"
    ).bind(mailbox).run()
  } catch {
    return Response.json({ error: 'Failed to pause mailbox (status column may not exist)' }, { status: 500 })
  }

  return Response.json({ mailbox, status: 'paused' })
}

/**
 * PATCH /api/mailbox/resume — set mailbox status to 'active'
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
    await env.DB.prepare(
      "UPDATE auth_tokens SET status = 'active' WHERE mailbox = ?"
    ).bind(mailbox).run()
  } catch {
    return Response.json({ error: 'Failed to resume mailbox (status column may not exist)' }, { status: 500 })
  }

  return Response.json({ mailbox, status: 'active' })
}
