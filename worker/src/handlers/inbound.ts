import type { Env } from '../types'
import type { ParsedAttachment } from '../mime'
import { attachmentContentToUint8Array, TEXT_EXTRACTION_LIMIT_BYTES, TEXT_ATTACHMENT_TYPES } from '../mime'

type TextExtractionStatus = ParsedAttachment['text_extraction_status']
import { extractCode } from '../extract-code'
import { resolveThreadId } from '../threading'
import { detectLabels } from '../auto-label'
import { recordEvent } from './events'
import { recordFunnelEvent } from './funnel'
import { tokenSubjectId } from './privacy'
import { fireWebhookWithRetry } from './webhook'
import { generateAndStoreEmbedding } from '../embeddings'
import { parseFromName } from './send'
import { verifyResendSignature } from './resend-sig'

const R2_UPLOAD_THRESHOLD = 100_000 // 100KB
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024 // 100MB
const R2_UPLOAD_TIMEOUT = 30_000 // 30s


/**
 * Already-parsed inbound email, ready to persist. Both the Cloudflare Email
 * Routing `email()` handler (after MIME parsing) and the Resend Inbound webhook
 * (after fetching the parsed body from Resend) produce this shape.
 */
export interface InboundIngestInput {
  id: string
  /** Recipient mailbox (the local address that received this email). */
  mailbox: string
  /** RFC5322 "From:" address of the real sender. */
  realFrom: string
  fromName: string
  /** Envelope sender (return-path); stored for debugging. */
  envelopeFrom: string
  subject: string
  bodyText: string
  bodyHtml: string
  headers: Record<string, string>
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  attachments: ParsedAttachment[]
  attachmentCount: number
  attachmentNames: string
  attachmentSearchText: string
  /** R2 key of the raw MIME backup, if any (null for Resend inbound). */
  rawKey: string | null
  source: 'cf-email' | 'resend-inbound'
}

type InboundRecipient = {
  accepted: boolean
  token: string | null
}

/**
 * Catch-all email routing must not become unbounded storage. Accept inbound
 * mail only for an active, unexpired mailbox that has an authentication token.
 */
export async function resolveInboundRecipient(env: Env, mailbox: string): Promise<InboundRecipient> {
  const normalized = mailbox.trim().toLowerCase()
  if (!normalized) return { accepted: false, token: null }

  try {
    const row = await env.DB.prepare(
      `SELECT token, status, expires_at
       FROM auth_tokens
       WHERE lower(mailbox) = ?
       LIMIT 1`
    ).bind(normalized).first<{
      token: string
      status: string | null
      expires_at: string | null
    }>()
    if (!row || row.status === 'paused') return { accepted: false, token: null }
    if (row.expires_at) {
      const expiresAt = Date.parse(row.expires_at)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return { accepted: false, token: null }
      }
    }
    return { accepted: true, token: row.token }
  } catch (error) {
    // Pre-expiry schemas remain supported, but an unknown mailbox or a D1
    // failure still fails closed.
    try {
      const row = await env.DB.prepare(
        'SELECT token, status FROM auth_tokens WHERE lower(mailbox) = ? LIMIT 1'
      ).bind(normalized).first<{ token: string; status: string | null }>()
      if (!row || row.status === 'paused') return { accepted: false, token: null }
      return { accepted: true, token: row.token }
    } catch {
      console.error(
        '[inbound] recipient authorization failed:',
        error instanceof Error ? error.message : String(error),
      )
      return { accepted: false, token: null }
    }
  }
}

/**
 * Persist a parsed inbound email and fire all downstream side effects
 * (auto-labels, SSE event, user webhook, embedding, activation funnel).
 *
 * Idempotent via `INSERT OR IGNORE` on the UNIQUE(mailbox, message_id) index.
 * Returns `{ duplicate: true }` when the message was already stored.
 *
 * The caller owns the `ingest_log` lifecycle: it should insert a 'pending' row
 * (keyed by `input.id`) before calling, and this function flips it to 'parsed'
 * (or annotates a duplicate). On failure the caller records 'failed'.
 */
export async function ingestParsedInbound(
  env: Env,
  ctx: ExecutionContext,
  input: InboundIngestInput,
): Promise<{ duplicate: boolean }> {
  const now = new Date().toISOString()
  const { id, mailbox, realFrom, fromName } = input
  const recipient = await resolveInboundRecipient(env, mailbox)
  if (!recipient.accepted || !recipient.token) {
    throw new Error('Mailbox is not active or has expired')
  }
  const subject = input.subject || ''
  const code = extractCode(`${subject} ${input.bodyText}`)

  const threadId = await resolveThreadId(
    input.inReplyTo, input.references, input.messageId, env.DB, mailbox,
  )
  const labels = detectLabels(realFrom, input.headers, code)

  // Upload large attachments to R2 (no-op when env.ATTACHMENTS is unbound or
  // attachments carry no raw content — e.g. Resend inbound metadata-only mode).
  for (const att of input.attachments) {
    if (att.raw_content && att.size_bytes && att.size_bytes > R2_UPLOAD_THRESHOLD && env.ATTACHMENTS) {
      if (att.size_bytes > MAX_ATTACHMENT_SIZE) {
        console.warn(`Skipping oversized attachment ${att.filename} (${att.size_bytes} bytes, max ${MAX_ATTACHMENT_SIZE})`)
        continue
      }
      const key = `${id}/${att.id}`
      try {
        const uploadPromise = env.ATTACHMENTS.put(key, attachmentContentToUint8Array(att.raw_content))
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`R2 upload timed out after ${R2_UPLOAD_TIMEOUT}ms`)), R2_UPLOAD_TIMEOUT)
        )
        await Promise.race([uploadPromise, timeoutPromise])
        att.storage_key = key
        att.downloadable = true
        console.log(`R2 upload: ${key} (${att.size_bytes} bytes)`)
      } catch (err) {
        console.error(`R2 upload failed for ${key}:`, err)
      }
    }
  }

  const insertResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO emails (
      id, mailbox, from_address, from_name, to_address, subject,
      body_text, body_html, code, headers, metadata, message_id,
      thread_id, in_reply_to, "references",
      has_attachments, attachment_count, attachment_names, attachment_search_text,
      raw_storage_key, direction, status, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?)
  `).bind(
    id, mailbox, realFrom, fromName, mailbox, subject,
    input.bodyText.slice(0, 50000),
    input.bodyHtml.slice(0, 100000),
    code,
    JSON.stringify(input.headers),
    JSON.stringify({ envelope_from: input.envelopeFrom, source: input.source }),
    input.messageId,
    threadId,
    input.inReplyTo,
    input.references,
    input.attachmentCount > 0 ? 1 : 0,
    input.attachmentCount,
    input.attachmentNames,
    input.attachmentSearchText,
    input.rawKey, now, now,
  ).run()

  if (!insertResult.meta.changes) {
    console.log(`Duplicate inbound email ignored id=${id} to=${mailbox} message_id=${input.messageId}`)
    try {
      await env.DB.prepare(
        'UPDATE ingest_log SET status = ?, error_message = ? WHERE id = ?'
      ).bind('parsed', 'duplicate message_id ignored', id).run()
    } catch { /* non-critical */ }
    if (input.rawKey && env.ATTACHMENTS) {
      ctx.waitUntil(env.ATTACHMENTS.delete(input.rawKey).catch(() => {}))
    }
    return { duplicate: true }
  }

  if (input.attachments.length > 0) {
    await env.DB.batch(input.attachments.map((attachment) =>
      env.DB.prepare(`
        INSERT OR IGNORE INTO attachments (
          id, email_id, filename, content_type, size_bytes,
          content_disposition, content_id, mime_part_index,
          text_content, text_extraction_status, storage_key, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        attachment.id, attachment.email_id, attachment.filename,
        attachment.content_type, attachment.size_bytes,
        attachment.content_disposition, attachment.content_id,
        attachment.mime_part_index, attachment.text_content,
        attachment.text_extraction_status, attachment.storage_key,
        attachment.created_at,
      )
    ))
  }

  try {
    await env.DB.prepare(
      'UPDATE ingest_log SET status = ?, email_id = ? WHERE id = ?'
    ).bind('parsed', id, id).run()
  } catch (err) {
    console.warn(`Ingest log update failed for ${id}:`, err)
  }

  console.log(`Email received id=${id} to=${mailbox} from=${realFrom} source=${input.source} subject="${subject.slice(0, 50)}" thread=${threadId.slice(0, 8)} labels=${labels.join(',')} attachments=${input.attachmentCount}`)

  if (labels.length > 0) {
    try {
      await env.DB.batch(
        labels.map((label) =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO email_labels (id, email_id, label, source, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), id, label, 'auto', now)
        )
      )
    } catch (err) {
      console.error(`Label insertion failed for email ${id}:`, err)
    }
  }

  const eventPayload = {
    event: 'message.received',
    email_id: id,
    mailbox,
    from: realFrom,
    subject,
    received_at: now,
    message_id: input.messageId,
    thread_id: threadId,
    labels,
    has_attachments: input.attachmentCount > 0,
    attachment_count: input.attachmentCount,
  }
  ctx.waitUntil(recordEvent(env, 'message.received', mailbox, eventPayload))

  // Durable activation funnel. Token subjects are one-way identifiers derived
  // from a high-entropy secret; no sender, subject, body, address, or raw token
  // is copied into analytics.
  ctx.waitUntil((async () => {
    try {
      const prior = await env.DB.prepare(
        'SELECT id FROM emails WHERE mailbox = ? AND id != ? LIMIT 1'
      ).bind(mailbox, id).first()
      if (!prior) {
        const anonymousId = await tokenSubjectId(recipient.token!, env)
        await recordFunnelEvent(env, 'first_email_received', anonymousId, {
          source: input.source,
          clientName: 'inbound-worker',
          flow: 'inbound',
        })
      }
    } catch { /* non-critical */ }
  })())

  ctx.waitUntil(fireWebhookWithRetry(env, mailbox, eventPayload))
  ctx.waitUntil(generateAndStoreEmbedding(env, id, mailbox, subject, fromName, input.bodyText))

  return { duplicate: false }
}

// ---------------------------------------------------------------------------
// Resend Inbound webhook
// ---------------------------------------------------------------------------

/**
 * Coerce a Resend address field to an "Name <addr>" / "addr" string.
 * Resend may return a plain string, an array of addresses, or an object
 * ({ address|email, name }) — handle all shapes so we never silently drop mail.
 */
function extractAddress(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = extractAddress(v)
      if (s) return s
    }
    return ''
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const addr = (typeof o.address === 'string' && o.address)
      || (typeof o.email === 'string' && o.email)
      || ''
    if (addr) {
      const name = typeof o.name === 'string' ? o.name : ''
      return name ? `${name} <${addr}>` : addr
    }
  }
  return ''
}

/** Extract the bare email address from "Name <addr@x>" or a plain address. */
function bareAddress(value: string): string {
  const m = value.match(/<([^>]+)>/)
  return (m ? m[1] : value).trim().toLowerCase()
}

/** Coerce Resend's `headers` (object map or [{name,value}] array) to a record. */
function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (h && typeof h === 'object' && 'name' in h && 'value' in h) {
        out[String((h as { name: unknown }).name)] = String((h as { value: unknown }).value)
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v)
  }
  return out
}

function headerLookup(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v
  }
  return null
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string
  }
  return null
}

/**
 * Fetch the inbound email's attachments from Resend, download each binary from
 * its (short-lived) signed URL, store it in R2, and return rows ready to insert.
 *
 * The returned attachments carry an empty `raw_content` so the shared upload
 * loop in {@link ingestParsedInbound} skips re-uploading — the binary is already
 * in R2 under `storage_key`. Failures are isolated per-attachment and never
 * block email storage. Returns `[]` when R2 is unbound or the list is empty.
 */
async function fetchInboundAttachments(
  env: Env,
  emailId: string,
  parentId: string,
  now: string,
): Promise<ParsedAttachment[]> {
  if (!env.RESEND_API_KEY) return []

  let list: Array<Record<string, unknown>>
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    })
    if (!res.ok) {
      if (res.status !== 404) console.warn(`Resend attachments list failed id=${emailId} status=${res.status}`)
      return []
    }
    const j = await res.json() as unknown
    if (Array.isArray(j)) {
      list = j as Array<Record<string, unknown>>
    } else if (j && typeof j === 'object' && Array.isArray((j as { data?: unknown }).data)) {
      list = (j as { data: Array<Record<string, unknown>> }).data
    } else {
      list = []
    }
  } catch (err) {
    console.error(`Resend attachments list threw id=${emailId}:`, err)
    return []
  }

  const out: ParsedAttachment[] = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i] ?? {}
    const filename = pickString(a, 'filename', 'name') ?? `attachment-${i + 1}`
    const contentType = pickString(a, 'content_type', 'contentType') ?? 'application/octet-stream'
    const sizeRaw = a.size ?? a.size_bytes
    const size = typeof sizeRaw === 'number' ? sizeRaw : null
    const downloadUrl = pickString(a, 'download_url', 'downloadUrl', 'url')
    const attId = crypto.randomUUID()

    let storageKey: string | null = null
    let textContent = ''
    let textStatus: TextExtractionStatus = 'pending'

    if (size !== null && size > MAX_ATTACHMENT_SIZE) {
      console.warn(`Skipping oversized inbound attachment ${filename} (${size} bytes, max ${MAX_ATTACHMENT_SIZE})`)
      textStatus = 'too_large'
    } else if (downloadUrl && env.ATTACHMENTS) {
      try {
        const dl = await fetch(downloadUrl, { signal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT) })
        if (!dl.ok) throw new Error(`download HTTP ${dl.status}`)
        const buf = await dl.arrayBuffer()
        if (buf.byteLength > MAX_ATTACHMENT_SIZE) {
          throw new Error(`downloaded ${buf.byteLength} bytes exceeds max ${MAX_ATTACHMENT_SIZE}`)
        }
        const key = `${parentId}/${attId}`
        const putPromise = env.ATTACHMENTS.put(key, buf)
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`R2 upload timed out after ${R2_UPLOAD_TIMEOUT}ms`)), R2_UPLOAD_TIMEOUT)
        )
        await Promise.race([putPromise, timeoutPromise])
        storageKey = key
        if (TEXT_ATTACHMENT_TYPES.has(contentType) && buf.byteLength <= TEXT_EXTRACTION_LIMIT_BYTES) {
          textContent = new TextDecoder().decode(buf).slice(0, TEXT_EXTRACTION_LIMIT_BYTES)
          textStatus = 'done'
        } else {
          textStatus = 'unsupported'
        }
        console.log(`Inbound attachment stored: ${key} (${buf.byteLength} bytes, ${contentType})`)
      } catch (err) {
        console.error(`Inbound attachment download/store failed ${filename} id=${emailId}:`, err)
        textStatus = 'failed'
      }
    } else {
      // No download URL or R2 unbound — record metadata only.
      textStatus = 'unsupported'
    }

    out.push({
      id: attId,
      email_id: parentId,
      filename,
      content_type: contentType,
      size_bytes: size,
      content_disposition: null,
      content_id: null,
      mime_part_index: i,
      text_content: textContent,
      text_extraction_status: textStatus,
      storage_key: storageKey,
      downloadable: storageKey !== null,
      created_at: now,
      raw_content: '',
    })
  }
  return out
}

/**
 * Process a verified Resend `email.received` event: fetch the full parsed body
 * from Resend's receiving API and persist it via {@link ingestParsedInbound}.
 *
 * Resend's webhook payload carries metadata only; the body/headers are fetched
 * from `GET /emails/receiving/{id}` and attachments from the attachments list
 * endpoint (each binary downloaded to R2 — see {@link fetchInboundAttachments}).
 */
export async function processResendInboundEvent(
  body: { type?: string; data?: Record<string, unknown> },
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const emailId = typeof body.data?.email_id === 'string' ? body.data.email_id : null
  if (!emailId) {
    return Response.json({ error: 'Missing data.email_id' }, { status: 400 })
  }
  // Constrain the id before interpolating it into the Resend API URL (defense in
  // depth — this path is already signature-gated). Resend ids are uuid-like.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(emailId)) {
    return Response.json({ error: 'Invalid data.email_id' }, { status: 400 })
  }
  if (!env.RESEND_API_KEY) {
    return Response.json({ error: 'RESEND_API_KEY not configured' }, { status: 503 })
  }

  // Fetch the full parsed inbound email from Resend.
  let full: Record<string, unknown>
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`Resend receiving fetch failed id=${emailId} status=${res.status}: ${text.slice(0, 200)}`)
      // 4xx: nothing to retry. 5xx: ask Resend to retry by returning 502.
      return Response.json({ error: 'Failed to fetch inbound email' }, { status: res.status >= 500 ? 502 : 200 })
    }
    full = await res.json()
  } catch (err) {
    console.error(`Resend receiving fetch threw id=${emailId}:`, err)
    return Response.json({ error: 'Fetch error' }, { status: 502 })
  }

  const data = body.data ?? {}
  // Resend delivers one email.received event per received message; we ingest it
  // under the first recipient. If a single message is addressed to multiple of
  // your mailboxes in one event, only the first is stored (matches the one-row
  // mailbox-scoping model used elsewhere).
  const toRaw = extractAddress(full.to ?? data.to)
  const fromRaw = extractAddress(full.from ?? data.from)
  const mailbox = bareAddress(toRaw)
  if (!mailbox) {
    // Unexpected recipient shape — never silently drop. Persist an auditable
    // 'failed' row keyed to Resend's email_id (still retrievable from Resend via
    // GET /emails/receiving/{id}) so the message can be replayed manually, then
    // acknowledge (200) to avoid an infinite retry loop on an unparseable payload.
    console.error(`Resend inbound missing recipient id=${emailId} to=${JSON.stringify(full.to ?? data.to)}`)
    try {
      await env.DB.prepare(
        'INSERT INTO ingest_log (id, mailbox, raw_key, status, from_address, to_address, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        crypto.randomUUID(), 'unknown', '', 'failed', bareAddress(fromRaw), '',
        `missing recipient; resend_email_id=${emailId}; to=${JSON.stringify(full.to ?? data.to).slice(0, 400)}`,
        new Date().toISOString(),
      ).run()
    } catch (logErr) {
      console.error(`Failed to record missing-recipient ingest_log for ${emailId}:`, logErr)
    }
    return Response.json({ error: 'Missing recipient', email_id: emailId }, { status: 200 })
  }
  const recipient = await resolveInboundRecipient(env, mailbox)
  if (!recipient.accepted) {
    console.warn(`Resend inbound ignored for inactive or unknown mailbox id=${emailId}`)
    return Response.json({ ok: true, ignored: 'inactive_or_unknown_mailbox' })
  }
  const realFrom = bareAddress(fromRaw)
  const headers = normalizeHeaders(full.headers)
  const subject = String(full.subject ?? data.subject ?? '')
  const bodyHtml = typeof full.html === 'string' ? full.html : ''
  const bodyText = typeof full.text === 'string' ? full.text : ''
  const messageId = headerLookup(headers, 'Message-ID') ?? (typeof full.message_id === 'string' ? full.message_id : `resend-${emailId}`)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      'INSERT INTO ingest_log (id, mailbox, raw_key, status, from_address, to_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, mailbox, '', 'pending', realFrom, mailbox, now).run()
  } catch (err) {
    console.warn(`Ingest log insert failed for resend inbound ${id} (continuing):`, err)
  }

  // Download attachment binaries to R2 (best-effort, isolated failures).
  const attachments = await fetchInboundAttachments(env, emailId, id, now)
  const attachmentNames = attachments.map(a => a.filename).filter(Boolean).join(' ')
  const attachmentSearchText = attachments
    .map(a => `${a.filename} ${a.text_content}`.trim())
    .join(' ')
    .slice(0, 50000)

  try {
    const { duplicate } = await ingestParsedInbound(env, ctx, {
      id,
      mailbox,
      realFrom: realFrom || fromRaw,
      fromName: parseFromName(fromRaw),
      envelopeFrom: fromRaw,
      subject,
      bodyText,
      bodyHtml,
      headers,
      messageId,
      inReplyTo: headerLookup(headers, 'In-Reply-To'),
      references: headerLookup(headers, 'References'),
      attachments,
      attachmentCount: attachments.length,
      attachmentNames,
      attachmentSearchText,
      rawKey: null,
      source: 'resend-inbound',
    })
    // On a duplicate delivery the attachment rows are not inserted, so the
    // freshly-downloaded R2 objects (keyed by this run's id) are orphans — clean up.
    if (duplicate && env.ATTACHMENTS) {
      for (const a of attachments) {
        if (a.storage_key) ctx.waitUntil(env.ATTACHMENTS.delete(a.storage_key).catch(() => {}))
      }
    }
    return Response.json({ ok: true, email_id: id, duplicate })
  } catch (err) {
    console.error(`Resend inbound ingest failed id=${emailId}:`, err)
    try {
      await env.DB.prepare(
        'UPDATE ingest_log SET status = ?, error_message = ? WHERE id = ?'
      ).bind('failed', (err instanceof Error ? err.message : String(err)).slice(0, 1000), id).run()
    } catch { /* non-critical */ }
    // Ingestion failed after attachments were uploaded — Resend retries with a
    // fresh id, so delete this attempt's R2 objects to avoid orphan accumulation.
    if (env.ATTACHMENTS) {
      for (const a of attachments) {
        if (a.storage_key) ctx.waitUntil(env.ATTACHMENTS.delete(a.storage_key).catch(() => {}))
      }
    }
    return Response.json({ error: 'Ingest failed' }, { status: 502 })
  }
}

/**
 * Dedicated endpoint: POST /api/resend-inbound
 * Verifies the Svix signature (RESEND_WEBHOOK_SECRET) and processes
 * `email.received` events. Other event types are acknowledged and ignored.
 */
export async function handleResendInbound(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text()

  if (!env.RESEND_WEBHOOK_SECRET) {
    return Response.json({ error: 'Webhook secret not configured' }, { status: 503 })
  }
  if (!(await verifyResendSignature(request, rawBody, env.RESEND_WEBHOOK_SECRET))) {
    return Response.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

  let body: { type?: string; data?: Record<string, unknown> }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (body.type !== 'email.received') {
    return Response.json({ ok: true, ignored: body.type })
  }
  return processResendInboundEvent(body, env, ctx)
}
