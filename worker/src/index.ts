import { extractCode } from './extract-code'
import { parseIncomingEmail } from './mime'

export interface Env {
  DB: D1Database
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    let response: Response

    switch (url.pathname) {
      case '/api/inbox':
        response = await handleInbox(url, env)
        break
      case '/api/code':
        response = await handleGetCode(url, env)
        break
      case '/api/email':
        response = await handleGetEmail(url, env)
        break
      case '/health':
        response = Response.json({ ok: true })
        break
      default:
        response = Response.json({ name: 'mails-worker', version: '1.0.0' })
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value)
    }
    return response
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = message.to
    const from = message.from
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const parsed = await parseIncomingEmail(await new Response(message.raw).arrayBuffer(), id, now)
    const subject = parsed.subject || message.headers.get('subject') || ''
    const code = extractCode(`${subject} ${parsed.bodyText}`)
    const fromName = parseFromName(message.headers.get('from') ?? from)
    const statements = [
      env.DB.prepare(`
        INSERT INTO emails (
          id, mailbox, from_address, from_name, to_address, subject,
          body_text, body_html, code, headers, metadata, message_id,
          has_attachments, attachment_count, attachment_names, attachment_search_text,
          raw_storage_key, direction, status, received_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?)
      `).bind(
        id,
        to,
        from,
        fromName,
        to,
        subject,
        parsed.bodyText.slice(0, 50000),
        parsed.bodyHtml.slice(0, 100000),
        code,
        JSON.stringify(parsed.headers),
        JSON.stringify({}),
        parsed.messageId,
        parsed.attachmentCount > 0 ? 1 : 0,
        parsed.attachmentCount,
        parsed.attachmentNames,
        parsed.attachmentSearchText,
        null,
        now,
        now
      ),
      ...parsed.attachments.map((attachment) =>
        env.DB.prepare(`
          INSERT INTO attachments (
            id, email_id, filename, content_type, size_bytes,
            content_disposition, content_id, mime_part_index,
            text_content, text_extraction_status, storage_key, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          attachment.id,
          attachment.email_id,
          attachment.filename,
          attachment.content_type,
          attachment.size_bytes,
          attachment.content_disposition,
          attachment.content_id,
          attachment.mime_part_index,
          attachment.text_content,
          attachment.text_extraction_status,
          attachment.storage_key,
          attachment.created_at
        )
      ),
    ]

    await env.DB.batch(statements)
  },
} satisfies ExportedHandler<Env>

// --- HTTP Handlers ---

async function handleGetCode(url: URL, env: Env): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })

  const timeoutSec = Math.min(parseInt(url.searchParams.get('timeout') ?? '30'), 55)
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

async function handleInbox(url: URL, env: Env): Promise<Response> {
  const to = url.searchParams.get('to')
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
    const pattern = `%${query}%`
    sql += ' AND (subject LIKE ? OR body_text LIKE ? OR from_address LIKE ? OR from_name LIKE ? OR code LIKE ?)'
    params.push(pattern, pattern, pattern, pattern, pattern)
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

async function handleGetEmail(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  const row = await env.DB.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first<{
    id: string
    mailbox: string
    from_address: string
    from_name: string
    to_address: string
    subject: string
    body_text: string
    body_html: string
    code: string | null
    headers: string
    metadata: string
    direction: 'inbound' | 'outbound'
    status: 'received' | 'sent' | 'failed' | 'queued'
    message_id: string | null
    has_attachments: number
    attachment_count: number
    attachment_names: string
    attachment_search_text: string
    raw_storage_key: string | null
    received_at: string
    created_at: string
  }>()

  if (!row) return Response.json({ error: 'Email not found' }, { status: 404 })

  const attachments = await env.DB.prepare(
    'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
  ).bind(id).all<{
    id: string
    email_id: string
    filename: string
    content_type: string
    size_bytes: number | null
    content_disposition: string | null
    content_id: string | null
    mime_part_index: number
    text_content: string
    text_extraction_status: string
    storage_key: string | null
    created_at: string
  }>()

  return Response.json({
    ...row,
    headers: safeJsonParse(row.headers, {}),
    metadata: safeJsonParse(row.metadata, {}),
    has_attachments: Boolean(row.has_attachments),
    attachment_count: row.attachment_count ?? 0,
    attachments: attachments.results.map((attachment) => ({
      ...attachment,
      downloadable: Boolean(attachment.storage_key),
    })),
  })
}

function parseFromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1]!.trim() : ''
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
