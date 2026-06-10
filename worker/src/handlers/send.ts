import type { Env } from '../types'
import { recordEvent } from './events'

const MAX_TOTAL_RECIPIENTS = 50
const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
const DEFAULT_GLOBAL_DAILY_SEND_LIMIT = 200
const DEFAULT_NEW_MAILBOX_SEND_LIMIT = 5
const DEFAULT_NEW_MAILBOX_SEND_WINDOW_HOURS = 24

const KNOWN_ABUSE_SUBJECTS = new Set([
  'action required: verify your account',
  'payment required for your account',
  'your account requires attention',
  'your account is past due',
  'important: account update needed',
  'security alert: account activity',
  'notice: account status change',
  'urgent: account verification required',
])

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

  // Warm-up gate — new mailboxes cannot send for the first 24h after claim.
  // Inbound + read paths remain open (this is the agent-OTP hot path).
  if (mailbox) {
    try {
      const warmupResult = await checkSendWarmup(env, mailbox)
      if (warmupResult) {
        return Response.json(warmupResult.body, {
          status: 403,
          headers: warmupResult.retryAt
            ? { 'Retry-After': String(warmupResult.retryAt) }
            : undefined,
        })
      }
    } catch (err) {
      // Fail-open on storage errors so a single bad query doesn't lock out
      // a legitimate mailbox. The abuse guard below still applies.
      console.warn('Send warm-up check errored, continuing:', err)
    }
  }

  if (mailbox) {
    try {
      const abuseResult = await checkOutboundAbuseGuard(env, mailbox, {
        subject: body.subject,
        text: body.text ?? '',
        html: body.html ?? '',
        recipients: allRecipients,
      })
      if (abuseResult) {
        return Response.json({ error: abuseResult }, { status: 400 })
      }
    } catch (err) {
      console.error('Outbound abuse guard failed, rejecting send:', err)
      return Response.json(
        { error: 'Unable to verify message safety, please try again' },
        { status: 503 },
      )
    }
  }

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

  // Merge a SAFE SUBSET of caller-supplied headers, then In-Reply-To/References.
  // `from` is already pinned to the mailbox; without this allowlist a caller
  // could inject arbitrary RFC5322 headers (Reply-To/Return-Path/From-overrides)
  // and bypass that pinning or harm deliverability.
  const ALLOWED_HEADERS = new Set(['reply-to', 'in-reply-to', 'references', 'x-entity-ref-id'])
  const mergedHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(body.headers ?? {})) {
    if (typeof v === 'string' && ALLOWED_HEADERS.has(k.toLowerCase())) mergedHeaders[k] = v
  }
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

type WarmupResult = {
  body: { error: string; send_unlocks_at: string; warmup_remaining_seconds: number }
  retryAt: number
}

/**
 * Check the send warm-up window for a mailbox.
 *
 * Returns null when the mailbox can send. Returns a structured rejection when
 * the mailbox is still in its warm-up window (send_unlocks_at in the future).
 *
 * Auto-unlocks (clears send_unlocks_at) when the window has elapsed — this
 * way the column means "warming up right now" rather than "ever warmed up,"
 * keeps queries cheap, and provides a single source of truth for the audit.
 *
 * Fails open if the auth_tokens.send_unlocks_at column doesn't exist (older
 * deployments running before migration 0012 land).
 */
async function checkSendWarmup(env: Env, mailbox: string): Promise<WarmupResult | null> {
  if (env.SEND_WARMUP_ENABLED === '0' || env.SEND_WARMUP_ENABLED === 'false') {
    return null
  }

  let row: { send_unlocks_at: string | null } | null = null
  try {
    row = await env.DB.prepare(
      'SELECT send_unlocks_at FROM auth_tokens WHERE mailbox = ? LIMIT 1'
    ).bind(mailbox).first<{ send_unlocks_at: string | null }>()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('no such column') || msg.includes('has no column')) {
      return null
    }
    throw err
  }

  if (!row || !row.send_unlocks_at) return null

  const unlockMs = Date.parse(row.send_unlocks_at)
  if (!Number.isFinite(unlockMs)) {
    // Garbage timestamp — clear and allow send.
    await env.DB.prepare(
      'UPDATE auth_tokens SET send_unlocks_at = NULL WHERE mailbox = ?'
    ).bind(mailbox).run().catch(() => undefined)
    return null
  }

  const remainingMs = unlockMs - Date.now()
  if (remainingMs <= 0) {
    // Window elapsed — graduate the mailbox.
    await env.DB.prepare(
      'UPDATE auth_tokens SET send_unlocks_at = NULL WHERE mailbox = ?'
    ).bind(mailbox).run().catch(() => undefined)
    return null
  }

  const remainingSec = Math.ceil(remainingMs / 1000)
  return {
    body: {
      error: `Mailbox is in warm-up. New mailboxes cannot send until 24h after claim. Unlocks at ${row.send_unlocks_at}.`,
      send_unlocks_at: row.send_unlocks_at,
      warmup_remaining_seconds: remainingSec,
    },
    retryAt: remainingSec,
  }
}

type OutboundAbuseInput = {
  subject: string
  text: string
  html: string
  recipients: string[]
}

async function checkOutboundAbuseGuard(
  env: Env,
  mailbox: string,
  input: OutboundAbuseInput,
): Promise<string | null> {
  if (env.SEND_ABUSE_GUARD_ENABLED === '0' || env.SEND_ABUSE_GUARD_ENABLED === 'false') {
    return null
  }

  const risk = scoreOutboundRisk(input)
  if (risk.score < 3) return null

  if (KNOWN_ABUSE_SUBJECTS.has(input.subject.trim().toLowerCase())) {
    return 'Message rejected by abuse protection: high-risk account/payment/security template'
  }

  let mailboxCreatedAt: string | null = null
  let inboundCount = 0
  try {
    const tokenRow = await env.DB.prepare(
      'SELECT created_at FROM auth_tokens WHERE mailbox = ? LIMIT 1'
    ).bind(mailbox).first<{ created_at: string }>()
    mailboxCreatedAt = tokenRow?.created_at ?? null

    const inboundRow = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM emails WHERE mailbox = ? AND direction = 'inbound'"
    ).bind(mailbox).first<{ count: number }>()
    inboundCount = inboundRow?.count ?? 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('no such table')) return null
    throw err
  }

  const ageHours = mailboxCreatedAt ? hoursSince(mailboxCreatedAt) : null
  const newOrUntrustedMailbox =
    inboundCount === 0 ||
    ageHours === null ||
    ageHours < DEFAULT_NEW_MAILBOX_SEND_WINDOW_HOURS

  if (risk.score >= 5 && newOrUntrustedMailbox) {
    return `Message rejected by abuse protection: ${risk.flags.slice(0, 3).join(', ')}`
  }

  return null
}

function scoreOutboundRisk(input: OutboundAbuseInput): { score: number; flags: string[] } {
  const subject = input.subject.trim().toLowerCase()
  const body = `${input.text}\n${stripHtml(input.html)}`.toLowerCase()
  const rawHtml = input.html.toLowerCase()
  const content = `${subject}\n${body}\n${rawHtml}`
  const flags: string[] = []
  let score = 0

  if (KNOWN_ABUSE_SUBJECTS.has(subject)) {
    flags.push('known abuse subject')
    score += 5
  }
  if (/\b(action required|urgent|immediate action|requires attention)\b/.test(subject)) {
    flags.push('urgency language')
    score += 1
  }
  if (/\b(verify|verification|confirm|update)\b/.test(content) && /\b(account|login|identity|email)\b/.test(content)) {
    flags.push('account verification language')
    score += 2
  }
  if (/\b(payment required|past due|overdue|unpaid|billing issue)\b/.test(content)) {
    flags.push('payment pressure language')
    score += 2
  }
  if (/\b(security alert|account activity|status change|suspicious activity)\b/.test(content)) {
    flags.push('security alert impersonation language')
    score += 2
  }
  if (/\b(click here|sign in|log in|login|reset password|update your account)\b/.test(content) && /https?:\/\//.test(content)) {
    flags.push('credential-action link')
    score += 2
  }
  if (input.recipients.length > 10) {
    flags.push('bulk recipient fanout')
    score += 1
  }

  return { score, flags }
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
    const globalDailyLimit = readNonNegativeInt(env.GLOBAL_DAILY_SEND_LIMIT, DEFAULT_GLOBAL_DAILY_SEND_LIMIT)
    const newMailboxLimit = readNonNegativeInt(env.NEW_MAILBOX_SEND_LIMIT, DEFAULT_NEW_MAILBOX_SEND_LIMIT)
    const newMailboxWindowHours = readNonNegativeInt(
      env.NEW_MAILBOX_SEND_WINDOW_HOURS,
      DEFAULT_NEW_MAILBOX_SEND_WINDOW_HOURS,
    )

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

    if (row && newMailboxLimit > 0 && row.count > newMailboxLimit) {
      const tokenRow = await env.DB.prepare(
        'SELECT created_at FROM auth_tokens WHERE mailbox = ? LIMIT 1'
      ).bind(mailbox).first<{ created_at: string }>()
      const ageHours = tokenRow?.created_at ? hoursSince(tokenRow.created_at) : null
      if (ageHours === null || ageHours < newMailboxWindowHours) {
        await decrementDailySendCount(env, mailbox, today)
        return `New mailbox send limit reached (${newMailboxLimit}/${newMailboxWindowHours}h warmup window)`
      }
    }

    if (globalDailyLimit > 0) {
      const globalRow = await env.DB.prepare(
        'SELECT COALESCE(SUM(count), 0) as count FROM daily_send_counts WHERE date = ?'
      ).bind(today).first<{ count: number }>()
      if ((globalRow?.count ?? 0) > globalDailyLimit) {
        await decrementDailySendCount(env, mailbox, today)
        return `Global daily send limit reached (${globalDailyLimit}/day)`
      }
    }
    // Under limits: increment already applied, no further action needed
  } catch (err) {
    // Production should fail closed on rate-limit storage errors to protect
    // domain reputation. Self-hosted/legacy deployments without the table keep
    // working, and local debugging can opt into fail-open explicitly.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('no such table')) {
      return null
    }
    if (env.RATE_LIMIT_FAIL_OPEN === '1' || env.RATE_LIMIT_FAIL_OPEN === 'true') {
      console.warn('Rate limit check failed (explicit fail-open, allowing send):', err)
      return null
    }
    console.error('Rate limit check failed, rejecting send:', err)
    return 'Unable to verify send rate limits, please try again'
  }
  return null
}

async function decrementDailySendCount(env: Env, mailbox: string, date: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE daily_send_counts SET count = count - 1 WHERE mailbox = ? AND date = ?'
  ).bind(mailbox, date).run()
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

function hoursSince(value: string): number | null {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, (Date.now() - parsed) / 3_600_000)
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
