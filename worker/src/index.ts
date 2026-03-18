import { extractCode } from './extract-code'
import { parseIncomingEmail } from './mime'
import type { Email } from '../../src/core/types.js'

export interface Env {
  DB: D1Database
  FORWARD_URL?: string
  FORWARD_TOKEN?: string
  FORWARD_TIMEOUT_MS?: string
  READ_TOKEN?: string
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
        response = requireReadAuth(request, env) ?? await handleInbox(url, env)
        break
      case '/api/code':
        response = requireReadAuth(request, env) ?? await handleGetCode(url, env)
        break
      case '/api/email':
        response = requireReadAuth(request, env) ?? await handleGetEmail(url, env)
        break
      case '/api/attachment':
        response = requireReadAuth(request, env) ?? await handleGetAttachment(url, env)
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
    const parsed = await parseIncomingEmail(
      await new Response(message.raw).arrayBuffer(),
      id,
      now,
      { includeContent: true }
    )
    const subject = parsed.subject || message.headers.get('subject') || ''
    const code = extractCode(`${subject} ${parsed.bodyText}`)
    const fromName = parseFromName(message.headers.get('from') ?? from)
    const emailRecord: Email = {
      id,
      mailbox: to,
      from_address: from,
      from_name: fromName,
      to_address: to,
      subject,
      body_text: parsed.bodyText.slice(0, 50000),
      body_html: parsed.bodyHtml.slice(0, 100000),
      code,
      headers: parsed.headers,
      metadata: {},
      direction: 'inbound',
      status: 'received',
      message_id: parsed.messageId,
      has_attachments: parsed.attachmentCount > 0,
      attachment_count: parsed.attachmentCount,
      attachment_names: parsed.attachmentNames,
      attachment_search_text: parsed.attachmentSearchText,
      raw_storage_key: null,
      attachments: parsed.attachments,
      received_at: now,
      created_at: now,
    }
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
        emailRecord.id,
        emailRecord.mailbox,
        emailRecord.from_address,
        emailRecord.from_name,
        emailRecord.to_address,
        emailRecord.subject,
        emailRecord.body_text,
        emailRecord.body_html,
        emailRecord.code,
        JSON.stringify(emailRecord.headers),
        JSON.stringify({}),
        emailRecord.message_id,
        emailRecord.has_attachments ? 1 : 0,
        emailRecord.attachment_count,
        emailRecord.attachment_names,
        emailRecord.attachment_search_text,
        null,
        emailRecord.received_at,
        emailRecord.created_at
      ),
      ...(emailRecord.attachments ?? []).map((attachment) =>
        env.DB.prepare(`
          INSERT INTO attachments (
            id, email_id, filename, content_type, size_bytes,
            content_disposition, content_id, mime_part_index,
            text_content, text_extraction_status, storage_key, content_base64, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          attachment.content_base64,
          attachment.created_at
        )
      ),
    ]

    await env.DB.batch(statements)

    if (env.FORWARD_URL) {
      await forwardEmail(emailRecord, env)
    }
  },
} satisfies ExportedHandler<Env>

// --- HTTP Handlers ---

function requireReadAuth(request: Request, env: Env): Response | null {
  if (!env.READ_TOKEN) return null

  const authorization = request.headers.get('Authorization')
  if (authorization === `Bearer ${env.READ_TOKEN}`) {
    return null
  }

  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

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

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  const rows = await env.DB.prepare(
    `
      SELECT
        id, mailbox, from_address, from_name, subject, code, direction, status,
        received_at, has_attachments, attachment_count
      FROM emails
      WHERE mailbox = ?
      ORDER BY received_at DESC
      LIMIT ? OFFSET ?
    `
  ).bind(to, limit, offset).all()

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
    content_base64: string | null
    created_at: string
  }>()

  return Response.json({
    ...row,
    headers: safeJsonParse(row.headers, {}),
    metadata: safeJsonParse(row.metadata, {}),
    has_attachments: Boolean(row.has_attachments),
    attachment_count: row.attachment_count ?? 0,
    attachments: attachments.results.map((attachment) => ({
      id: attachment.id,
      email_id: attachment.email_id,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      content_disposition: attachment.content_disposition,
      content_id: attachment.content_id,
      mime_part_index: attachment.mime_part_index,
      text_content: attachment.text_content,
      text_extraction_status: attachment.text_extraction_status,
      storage_key: attachment.storage_key,
      created_at: attachment.created_at,
      downloadable: Boolean(attachment.storage_key || attachment.content_base64),
    })),
  })
}

async function handleGetAttachment(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  const attachment = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<{
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
    content_base64: string | null
    created_at: string
  }>()

  if (!attachment) return Response.json({ error: 'Attachment not found' }, { status: 404 })

  if (url.searchParams.get('format') === 'json') {
    return Response.json({
      id: attachment.id,
      email_id: attachment.email_id,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      content_disposition: attachment.content_disposition,
      content_id: attachment.content_id,
      mime_part_index: attachment.mime_part_index,
      text_content: attachment.text_content,
      text_extraction_status: attachment.text_extraction_status,
      storage_key: attachment.storage_key,
      created_at: attachment.created_at,
      downloadable: Boolean(attachment.storage_key || attachment.content_base64),
    })
  }

  if (!attachment.content_base64) {
    return Response.json({ error: 'Attachment content is not available' }, { status: 409 })
  }

  const content = decodeBase64(attachment.content_base64)
  const body = new Uint8Array(content.byteLength)
  body.set(content)

  return new Response(body, {
    headers: {
      'Content-Type': attachment.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${sanitizeAttachmentFilename(attachment.filename)}"`,
      'Content-Length': String(content.byteLength),
    },
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function sanitizeAttachmentFilename(value: string): string {
  const filename = value.split(/[/\\]+/).pop()?.replace(/[^A-Za-z0-9._-]/g, '_') ?? 'attachment'
  return filename.length > 0 ? filename : 'attachment'
}

async function forwardEmail(email: Email, env: Env): Promise<void> {
  const controller = new AbortController()
  const timeoutMs = readTimeout(env.FORWARD_TIMEOUT_MS)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(env.FORWARD_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.FORWARD_TOKEN ? { 'Authorization': `Bearer ${env.FORWARD_TOKEN}` } : {}),
      },
      body: JSON.stringify(email),
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error(`Failed to forward inbound email ${email.id}: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    console.error(`Failed to forward inbound email ${email.id}:`, error)
  } finally {
    clearTimeout(timer)
  }
}

function readTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return 5000
}
