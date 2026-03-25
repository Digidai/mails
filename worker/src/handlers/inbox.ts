import type { Env } from '../types'

export async function handleInbox(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const to = mailbox ?? url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0
  const direction = url.searchParams.get('direction')
  const query = url.searchParams.get('query')?.trim()

  let sql = `
    SELECT id, mailbox, from_address, from_name, subject, code, direction, status,
           received_at, has_attachments, attachment_count
    FROM emails WHERE mailbox = ?`
  const params: (string | number)[] = [to]

  if (direction === 'inbound' || direction === 'outbound') {
    sql += ' AND direction = ?'
    params.push(direction)
  }

  if (query) {
    // Sanitize query for FTS5: wrap in double quotes to treat as phrase literal,
    // preventing FTS5 operator injection (AND, OR, NOT, NEAR, *, etc.)
    const ftsQuery = '"' + query.replace(/"/g, '""') + '"'
    // Escape LIKE wildcards
    const likeQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_')
    // FTS5 for natural language search + LIKE fallback for email addresses
    sql += ` AND (
      rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)
      OR from_address LIKE ? ESCAPE '\\'
      OR to_address LIKE ? ESCAPE '\\'
    )`
    params.push(ftsQuery, `%${likeQuery}%`, `%${likeQuery}%`)
  }

  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = await env.DB.prepare(sql).bind(...params).all()

  return Response.json({
    emails: rows.results.map((row) => ({
      ...row,
      has_attachments: Boolean((row as { has_attachments?: number }).has_attachments),
      attachment_count: (row as { attachment_count?: number }).attachment_count ?? 0,
    })),
  })
}
