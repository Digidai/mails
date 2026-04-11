import type { Env } from '../types'

export async function handleGetCode(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const queryTo = url.searchParams.get('to')

  // If authenticated with a mailbox-scoped token, reject cross-mailbox ?to= queries
  // to avoid the surprising behavior where ?to=other@domain silently returns
  // the authenticated mailbox's code.
  if (mailbox && queryTo && queryTo !== mailbox) {
    return Response.json(
      { error: `Token is scoped to ${mailbox}, cannot query codes for ${queryTo}` },
      { status: 403 }
    )
  }

  const to = mailbox ?? queryTo
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })

  // Validate timeout: must be positive integer, max 55 seconds
  const rawTimeout = url.searchParams.get('timeout')
  let timeoutSec = 30
  if (rawTimeout !== null) {
    const n = parseInt(rawTimeout, 10)
    if (isNaN(n) || n < 1) {
      return Response.json({ error: 'timeout must be a positive integer (1-55)' }, { status: 400 })
    }
    timeoutSec = Math.min(n, 55)
  }

  const since = url.searchParams.get('since')
  const deadline = Date.now() + timeoutSec * 1000

  while (Date.now() < deadline) {
    let query = 'SELECT id, code, from_address, subject, received_at FROM emails WHERE mailbox = ? AND code IS NOT NULL'
    const params: string[] = [to]

    if (since) {
      query += ' AND received_at > ?'
      params.push(since)
    }

    query += ' ORDER BY received_at DESC LIMIT 1'

    const row = await env.DB.prepare(query).bind(...params).first<{
      id: string; code: string; from_address: string; subject: string; received_at: string
    }>()

    if (row) {
      return Response.json({
        id: row.id,
        code: row.code,
        from: row.from_address,
        subject: row.subject,
        received_at: row.received_at,
      })
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  return Response.json({ code: null })
}
