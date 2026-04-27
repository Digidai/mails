import type { Env } from '../types'
import { recordEvent } from './events'

const MAX_TOTAL_RECIPIENTS = 50
const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024

export async function handleSend(request: Request, env: Env, mailbox?: string, ctx?: ExecutionContext): Promise<Response> {
  if (!env.RESEND_API_KEY) {
    return Response.json(
      { error: 'Email sending is not available' },
      { status: 501 }
    )
  }

  type SendBody = {
    from: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    text?: string
    html?: string
    reply_to?: string
    in_reply_to?: string
    headers?: Record<string, string>
    attachments?: Array<{ filename: string; content: string; content_type?: string; content_id?: string }>
  }

  const contentType = request.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) {
    return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 })
  }

  let raw: Record<string, unknown>
  try {
    raw = await request.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 })
  }

  // Normalize and validate field types explicitly
  if (typeof raw.from !== 'string' || !raw.from.trim()) {
    return Response.json({ error: 'Field "from" must be a non-empty string' }, { status: 400 })
  }
  if (typeof raw.subject !== 'string') {
    return Response.json({ error: 'Field "subject" must be a string' }, { status: 400 })
  }

  // Accept `to` as string (single recipient) or array of strings.
  // This fixes the P0 bug where `to: "user@example.com"` returned 500.
  let toArray: string[]
  if (typeof raw.to === 'string') {
    toArray = [raw.to]
  } else if (Array.isArray(raw.to)) {
    if (!raw.to.every(r => typeof r === 'string')) {
      return Response.json({ error: 'Field "to" must be a string or array of strings' }, { status: 400 })
    }
    toArray = raw.to as string[]
  } else {
    return Response.json({ error: 'Field "to" is required (string or array of strings)' }, { status: 400 })
  }

  // Same for cc/bcc — accept string or array. Returns false for invalid input.
  const normalizeList = (val: unknown): string[] | undefined | false => {
    if (val === undefined || val === null) return undefined
    if (typeof val === 'string') return [val]
    if (Array.isArray(val) && val.every(v => typeof v === 'string')) return val as string[]
    return false
  }
  const ccArray = normalizeList(raw.cc)
  const bccArray = normalizeList(raw.bcc)
  if (ccArray === false) {
    return Response.json({ error: 'Field "cc" must be a string or array of strings' }, { status: 400 })
  }
  if (bccArray === false) {
    return Response.json({ error: 'Field "bcc" must be a string or array of strings' }, { status: 400 })
  }

  const body: SendBody = {
    from: raw.from,
    to: toArray,
    cc: ccArray,
    bcc: bccArray,
    subject: raw.subject,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    html: typeof raw.html === 'string' ? raw.html : undefined,
    reply_to: typeof raw.reply_to === 'string' ? raw.reply_to : undefined,
    in_reply_to: typeof raw.in_reply_to === 'string' ? raw.in_reply_to : undefined,
    headers: (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers))
      ? raw.headers as Record<string, string>
      : undefined,
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments as SendBody['attachments']
      : undefined,
  }

  if (!body.from || !body.to.length || !body.subject) {
    return Response.json({ error: 'Missing required fields: from, to, subject' }, { status: 400 })
  }

  if (!body.text && !body.html) {
    return Response.json({ error: 'Either text or html body is required' }, { status: 400 })
  }

  const recipientCount = body.to.length + (body.cc?.length ?? 0) + (body.bcc?.length ?? 0)
  if (recipientCount > MAX_TOTAL_RECIPIENTS) {
    return Response.json({ error: `Too many recipients (max ${MAX_TOTAL_RECIPIENTS} total across to/cc/bcc)` }, { status: 400 })
  }

  if (body.subject.length > 998) {
    return Response.json({ error: 'Subject too long (max 998 characters)' }, { status: 400 })
  }

  if ((body.text?.length ?? 0) > 500_000 || (body.html?.length ?? 0) > 1_000_000) {
    return Response.json({ error: 'Body too large' }, { status: 400 })
  }

  // Validate attachment base64 encoding
  if (body.attachments && body.attachments.length > 0) {
    if (body.attachments.length > MAX_ATTACHMENTS) {
      return Response.json({ error: `Too many attachments (max ${MAX_ATTACHMENTS})` }, { status: 400 })
    }
    let totalAttachmentBytes = 0
    for (const att of body.attachments) {
      if (typeof att.filename !== 'string' || !att.filename) {
        return Response.json({ error: 'Attachment "filename" must be a non-empty string' }, { status: 400 })
      }
      if (typeof att.content !== 'string') {
        return Response.json({ error: 'Attachment "content" must be a base64 string' }, { status: 400 })
      }
      // Validate base64 format: chars a-z A-Z 0-9 + / with optional = padding
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(att.content) || att.content.length % 4 !== 0) {
        return Response.json(
          { error: `Attachment "${att.filename}" has invalid base64 content` },
          { status: 400 }
        )
      }
      const decodedBytes = base64DecodedLength(att.content)
      if (decodedBytes > MAX_ATTACHMENT_BYTES) {
        return Response.json(
          { error: `Attachment "${att.filename}" is too large (max ${MAX_ATTACHMENT_BYTES} bytes)` },
          { status: 400 }
        )
      }
      totalAttachmentBytes += decodedBytes
      if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return Response.json(
          { error: `Attachments are too large in total (max ${MAX_TOTAL_ATTACHMENT_BYTES} bytes)` },
          { status: 400 }
        )
      }
    }
  }

  // Validate from address matches mailbox (if mailbox isolation is active)
  if (mailbox) {
    const fromEmail = extractEmail(body.from)
    if (fromEmail !== mailbox) {
      return Response.json(
        { error: `From address must match your mailbox: ${mailbox}` },
        { status: 403 }
      )
    }
  }

  // Check suppression list for all recipients (fail-closed: reject if check fails)
  // Normalize to lowercase: suppression_list stores lowercase, but senders may use mixed case
  const allRecipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])].map(e => e.toLowerCase())
  try {
    const suppressedCheck = await checkSuppressionList(env, allRecipients)
    if (suppressedCheck) {
      return Response.json(
        { error: `Recipient is suppressed: ${suppressedCheck.email} (${suppressedCheck.reason})` },
        { status: 400 }
      )
    }
  } catch (err) {
    // Fail-closed: if suppression check fails, reject send to protect domain reputation
    // Exception: if suppression_list table doesn't exist yet, allow send
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('no such table')) {
      // Table not created yet — safe to proceed
    } else {
      console.error('Suppression check failed, rejecting send:', err)
      return Response.json(
        { error: 'Unable to verify recipient safety, please try again' },
        { status: 503 }
      )
    }
  }

  // Check per-mailbox daily send rate limit
  if (mailbox) {
    const rateLimitResult = await checkDailySendLimit(env, mailbox)
    if (rateLimitResult) {
      return Response.json(
        { error: rateLimitResult },
        { status: 429 }
      )
    }
  }

  // Resolve in_reply_to for threading
  let threadId: string | undefined
  let inReplyToHeader: string | undefined
  let referencesHeader: string | undefined

  if (body.in_reply_to) {
    try {
      // CRITICAL: scope this query to the sender's mailbox. Without the mailbox
      // filter, an in_reply_to could pull another tenant's thread_id — cross-mailbox
      // leak + broken thread grouping (a reply would not share the thread of the
      // original in the sender's own mailbox).
      const sql = mailbox
        ? 'SELECT thread_id, message_id, in_reply_to, "references" FROM emails WHERE message_id = ? AND mailbox = ? LIMIT 1'
        : 'SELECT thread_id, message_id, in_reply_to, "references" FROM emails WHERE message_id = ? LIMIT 1'
      const params = mailbox ? [body.in_reply_to, mailbox] : [body.in_reply_to]
      const referenced = await env.DB.prepare(sql).bind(...params).first<{
        thread_id: string | null
        message_id: string | null
        in_reply_to: string | null
        references: string | null
      }>()

      if (referenced) {
        threadId = referenced.thread_id ?? undefined
        inReplyToHeader = body.in_reply_to
        // Build References chain: existing references + the message we're replying to
        const existingRefs = referenced.references?.trim() || ''
        referencesHeader = existingRefs
          ? `${existingRefs} ${body.in_reply_to}`
          : body.in_reply_to
      } else {
        // Referenced message not in this mailbox, still set the header for
        // downstream clients but do NOT inherit a thread_id from elsewhere.
        inReplyToHeader = body.in_reply_to
        referencesHeader = body.in_reply_to
      }
    } catch (err) {
      // DB lookup failed — still set headers, but log the error
      console.warn('Thread resolution DB lookup failed:', err)
      inReplyToHeader = body.in_reply_to
      referencesHeader = body.in_reply_to
    }
  }

  // If no thread_id was inherited from an existing thread, generate a fresh one
  // so every outbound email has a thread_id (fixes thread_id=null in response).
  if (!threadId) {
    threadId = crypto.randomUUID()
  }

  // Build Resend API request
  const resendBody: Record<string, unknown> = {
    from: body.from,
    to: body.to,
    subject: body.subject,
  }
  if (body.cc?.length) resendBody.cc = body.cc
  if (body.bcc?.length) resendBody.bcc = body.bcc
  if (body.text) resendBody.text = body.text
  if (body.html) resendBody.html = body.html
  if (body.reply_to) resendBody.reply_to = body.reply_to

  // Merge in_reply_to / references into headers
  const mergedHeaders: Record<string, string> = { ...(body.headers ?? {}) }
  if (inReplyToHeader) mergedHeaders['In-Reply-To'] = inReplyToHeader
  if (referencesHeader) mergedHeaders['References'] = referencesHeader

  if (Object.keys(mergedHeaders).length > 0) {
    resendBody.headers = mergedHeaders
  }
  if (body.attachments?.length) {
    resendBody.attachments = body.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.content_type ? { content_type: a.content_type } : {}),
      ...(a.content_id ? { content_id: a.content_id } : {}),
    }))
  }

  console.log(`Sending email from=${extractEmail(body.from)} to=${body.to.join(',')} subject="${body.subject.slice(0, 50)}"`)

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resendBody),
  })

  if (!resendRes.ok) {
    const err = await resendRes.json().catch(() => ({})) as { message?: string }
    const safeMessage = resendRes.status === 422
      ? (err.message ?? 'Validation error')
      : `Failed to send email (${resendRes.status})`
    console.error(`Send failed: ${safeMessage}`)
    return Response.json(
      { error: safeMessage },
      { status: resendRes.status }
    )
  }

  const resendData = await resendRes.json() as { id: string }

  // Return success immediately to prevent client retry causing double-send
  // D1 recording happens asynchronously via waitUntil
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const fromEmail = extractEmail(body.from)
  const fromName = parseFromName(body.from)

  console.log(`Sending email from=${fromEmail} to=${body.to.join(',')} subject="${body.subject}"`)
  console.log(`Email sent id=${id} resend_id=${resendData.id}`)

  // Async: record outbound email in D1 + activation tracking
  const asyncWork = async () => {
    try {
      // Daily send count is already incremented atomically in checkDailySendLimit()
      const attachmentNames = body.attachments?.map(a => a.filename).join(', ') ?? ''
      const toAddresses = body.to.join(', ')
      const metadata: Record<string, unknown> = {
        resend_id: resendData.id,
        ...(body.cc?.length ? { cc: body.cc } : {}),
        ...(body.bcc?.length ? { bcc: body.bcc } : {}),
      }
      await env.DB.prepare(`
        INSERT INTO emails (
          id, mailbox, from_address, from_name, to_address, subject,
          body_text, body_html, code, headers, metadata,
          message_id, thread_id, in_reply_to, "references",
          has_attachments, attachment_count, attachment_names, attachment_search_text,
          direction, status, received_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'outbound', 'sent', ?, ?)
      `).bind(
        id,
        mailbox ?? fromEmail,
        fromEmail,
        fromName,
        toAddresses,
        body.subject,
        body.text ?? '',
        body.html ?? '',
        JSON.stringify(mergedHeaders),
        JSON.stringify(metadata),
        null,
        threadId ?? null,
        inReplyToHeader ?? null,
        referencesHeader ?? null,
        body.attachments?.length ? 1 : 0,
        body.attachments?.length ?? 0,
        attachmentNames,
        now,
        now,
      ).run()
      // Activation funnel: check if this is the first email sent from this mailbox
      if (mailbox) {
        try {
          const senderMailbox = mailbox ?? fromEmail
          const priorSent = await env.DB.prepare(
            "SELECT id FROM emails WHERE mailbox = ? AND direction = 'outbound' AND id != ? LIMIT 1"
          ).bind(senderMailbox, id).first()
          if (!priorSent) {
            await recordEvent(env, 'activation.first_sent', senderMailbox, { email_id: id, to: body.to })
          }
        } catch { /* non-critical */ }
      }
    } catch (err) {
      console.error(`Failed to record outbound email id=${id} in D1:`, err)
    }
  }

  if (ctx) {
    ctx.waitUntil(asyncWork())
  } else {
    // No ExecutionContext (e.g., in tests) — run synchronously
    await asyncWork()
  }

  return Response.json({ id, provider_id: resendData.id, thread_id: threadId ?? null })
}

/**
 * Check suppression list for a list of recipients.
 * Returns the first suppressed email found, or null if none are suppressed.
 */
export async function checkSuppressionList(
  env: Env,
  recipients: string[],
): Promise<{ email: string; reason: string } | null> {
  if (recipients.length === 0) return null
  const placeholders = recipients.map(() => '?').join(', ')
  const row = await env.DB.prepare(
    `SELECT email, reason FROM suppression_list WHERE email IN (${placeholders}) LIMIT 1`
  ).bind(...recipients).first<{ email: string; reason: string }>()
  return row ?? null
}

/**
 * Check daily send rate limit for a mailbox using atomic increment-then-verify.
 * Increments the counter first (atomic), then checks the new count against the limit.
 * If over limit, decrements back and rejects. This prevents race conditions where
 * concurrent requests both pass a check-then-increment pattern.
 * Returns an error message if over limit, or null if OK.
 */
async function checkDailySendLimit(env: Env, mailbox: string): Promise<string | null> {
  try {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const dailyLimit = env.DAILY_SEND_LIMIT ? parseInt(env.DAILY_SEND_LIMIT as string, 10) : 100

    // Atomic increment
    await env.DB.prepare(
      `INSERT INTO daily_send_counts (mailbox, date, count) VALUES (?, ?, 1)
       ON CONFLICT (mailbox, date) DO UPDATE SET count = count + 1`
    ).bind(mailbox, today).run()

    // Read new count
    const row = await env.DB.prepare(
      'SELECT count FROM daily_send_counts WHERE mailbox = ? AND date = ?'
    ).bind(mailbox, today).first<{ count: number }>()

    if (row && row.count > dailyLimit) {
      // Over limit: decrement back and reject
      await env.DB.prepare(
        'UPDATE daily_send_counts SET count = count - 1 WHERE mailbox = ? AND date = ?'
      ).bind(mailbox, today).run()
      return `Daily send limit reached (${row.count - 1}/${dailyLimit})`
    }
    // Under limit: increment already applied, no further action needed
  } catch (err) {
    // Fail-open: rate limit check failure should not block sending
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('no such table')) {
      console.warn('Rate limit check failed (fail-open, allowing send):', err)
    }
  }
  return null
}

/** @deprecated Rate limit counting is now handled inside checkDailySendLimit atomically. */
async function incrementDailySendCount(env: Env, _mailbox: string): Promise<void> {
  // No-op: counting is now part of checkDailySendLimit's atomic increment-then-verify
}

export function parseFromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1]!.trim() : ''
}

export function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1]! : from
}

function base64DecodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding)
}
