import type { Env } from '../types'

export async function handleGetThreads(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const to = mailbox || url.searchParams.get('to')
  if (!to) {
    return Response.json({ error: 'Missing mailbox (to) parameter' }, { status: 400 })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100)
  const offset = parseInt(url.searchParams.get('offset') || '0')

  const { results } = await env.DB.prepare(`
    SELECT
      e.thread_id,
      e.id AS latest_email_id,
      e.from_address,
      e.from_name,
      e.subject,
      e.received_at,
      e.code,
      e.has_attachments,
      (SELECT COUNT(*) FROM emails e2 WHERE e2.thread_id = e.thread_id AND e2.mailbox = ?) AS message_count
    FROM emails e
    WHERE e.mailbox = ?
      AND e.thread_id IS NOT NULL
      AND e.received_at = (
        SELECT MAX(e3.received_at) FROM emails e3
        WHERE e3.thread_id = e.thread_id AND e3.mailbox = ?
      )
    ORDER BY e.received_at DESC
    LIMIT ? OFFSET ?
  `).bind(to, to, to, limit, offset).all<{
    thread_id: string
    latest_email_id: string
    from_address: string
    from_name: string
    subject: string
    received_at: string
    code: string | null
    has_attachments: number
    message_count: number
  }>()

  const threads = (results ?? []).map((row) => ({
    thread_id: row.thread_id,
    latest_email_id: row.latest_email_id,
    from_address: row.from_address,
    from_name: row.from_name,
    subject: row.subject,
    received_at: row.received_at,
    code: row.code,
    has_attachments: !!row.has_attachments,
    message_count: row.message_count,
  }))

  return Response.json({ threads })
}

export async function handleGetThread(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const threadId = url.searchParams.get('id')
  if (!threadId) {
    return Response.json({ error: 'Missing thread id parameter' }, { status: 400 })
  }

  const to = mailbox || url.searchParams.get('to')

  let query = `
    SELECT id, mailbox, from_address, from_name, to_address, subject,
           body_text, body_html, code, direction, status,
           message_id, thread_id, in_reply_to, "references",
           has_attachments, attachment_count, received_at, created_at
    FROM emails WHERE thread_id = ?
  `
  const params: unknown[] = [threadId]

  if (to) {
    query += ' AND mailbox = ?'
    params.push(to)
  }

  query += ' ORDER BY received_at ASC'

  const { results } = await env.DB.prepare(query).bind(...params).all()

  if (!results || results.length === 0) {
    return Response.json({ error: 'Thread not found' }, { status: 404 })
  }

  return Response.json({ thread_id: threadId, emails: results })
}
