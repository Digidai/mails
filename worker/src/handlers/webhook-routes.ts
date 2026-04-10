import type { Env } from '../types'

/**
 * Smart email routing: per-label webhook URLs.
 *
 * When an email is received with a specific label (code, newsletter,
 * notification, personal), it can be routed to a different webhook
 * URL than the default. This enables agents to handle different
 * email types with different workflows.
 *
 * GET    /api/mailbox/routes          — list all routes for mailbox
 * PUT    /api/mailbox/routes          — upsert route { label, webhook_url }
 * DELETE /api/mailbox/routes?label=x  — delete route for label
 */
export async function handleWebhookRoutes(
  request: Request,
  url: URL,
  env: Env,
  mailbox?: string,
): Promise<Response> {
  if (!mailbox) {
    return Response.json({ error: 'Mailbox required' }, { status: 400 })
  }

  if (request.method === 'GET') {
    try {
      const rows = await env.DB.prepare(
        'SELECT label, webhook_url, created_at FROM webhook_routes WHERE mailbox = ? ORDER BY label'
      ).bind(mailbox).all<{ label: string; webhook_url: string; created_at: string }>()
      return Response.json({ mailbox, routes: rows.results ?? [] })
    } catch {
      // Table may not exist yet
      return Response.json({ mailbox, routes: [] })
    }
  }

  if (request.method === 'PUT') {
    let body: { label: string; webhook_url: string }
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body.label || !body.webhook_url) {
      return Response.json({ error: 'Missing required fields: label, webhook_url' }, { status: 400 })
    }

    const validLabels = ['code', 'newsletter', 'notification', 'personal']
    if (!validLabels.includes(body.label)) {
      return Response.json({ error: `Invalid label. Must be one of: ${validLabels.join(', ')}` }, { status: 400 })
    }

    try {
      const urlCheck = new URL(body.webhook_url)
      if (!['http:', 'https:'].includes(urlCheck.protocol)) {
        return Response.json({ error: 'webhook_url must be http or https' }, { status: 400 })
      }
    } catch {
      return Response.json({ error: 'Invalid webhook_url' }, { status: 400 })
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    try {
      await env.DB.prepare(
        `INSERT INTO webhook_routes (id, mailbox, label, webhook_url, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (mailbox, label) DO UPDATE SET webhook_url = excluded.webhook_url`
      ).bind(id, mailbox, body.label, body.webhook_url, now).run()
    } catch (err) {
      console.error('Failed to upsert webhook route:', err)
      return Response.json({ error: 'Failed to save route' }, { status: 500 })
    }

    return Response.json({ mailbox, label: body.label, webhook_url: body.webhook_url })
  }

  if (request.method === 'DELETE') {
    const label = url.searchParams.get('label')
    if (!label) {
      return Response.json({ error: 'Missing query param: label' }, { status: 400 })
    }

    try {
      const result = await env.DB.prepare(
        'DELETE FROM webhook_routes WHERE mailbox = ? AND label = ?'
      ).bind(mailbox, label).run()
      if (!result.meta.changes) {
        return Response.json({ error: 'Route not found' }, { status: 404 })
      }
    } catch (err) {
      console.error('Failed to delete webhook route:', err)
      return Response.json({ error: 'Failed to delete route' }, { status: 500 })
    }

    return Response.json({ ok: true, deleted: label })
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

/**
 * Get label-specific webhook URLs for a mailbox.
 * Returns a map of label → webhook_url.
 */
export async function getWebhookRoutes(
  env: Env,
  mailbox: string,
): Promise<Record<string, string>> {
  try {
    const rows = await env.DB.prepare(
      'SELECT label, webhook_url FROM webhook_routes WHERE mailbox = ?'
    ).bind(mailbox).all<{ label: string; webhook_url: string }>()
    const routes: Record<string, string> = {}
    for (const row of rows.results ?? []) {
      routes[row.label] = row.webhook_url
    }
    return routes
  } catch {
    return {}
  }
}
