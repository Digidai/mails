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
