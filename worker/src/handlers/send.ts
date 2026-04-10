import type { Env } from '../types'

export async function handleSend(request: Request, env: Env, mailbox?: string, ctx?: ExecutionContext): Promise<Response> {
  if (!env.RESEND_API_KEY) {
    return Response.json(
      { error: 'Email sending is not available' },
      { status: 501 }
    )
  }

  let body: {
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

  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.from || !body.to?.length || !body.subject) {
    return Response.json({ error: 'Missing required fields: from, to, subject' }, { status: 400 })
  }

  if (!body.text && !body.html) {
    return Response.json({ error: 'Either text or html body is required' }, { status: 400 })
  }

  if (body.to.length > 50) {
    return Response.json({ error: 'Too many recipients (max 50)' }, { status: 400 })
  }

  if (body.subject.length > 998) {
    return Response.json({ error: 'Subject too long (max 998 characters)' }, { status: 400 })
  }

  if ((body.text?.length ?? 0) > 500_000 || (body.html?.length ?? 0) > 1_000_000) {
    return Response.json({ error: 'Body too large' }, { status: 400 })
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
  const allRecipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])]
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
      const referenced = await env.DB.prepare(
        'SELECT thread_id, message_id, in_reply_to, "references" FROM emails WHERE message_id = ? LIMIT 1'
      ).bind(body.in_reply_to).first<{
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
        // Referenced message not found, still set the header
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

  console.log(`Email sent id=${id} resend_id=${resendData.id}`)

  // Async: record outbound email in D1 + increment daily count
  const asyncWork = async () => {
    try {
      if (mailbox) {
        await incrementDailySendCount(env, mailbox)
      }
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
        fromEmail,
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
 * Check daily send rate limit for a mailbox.
 * Returns an error message if over limit, or null if OK.
 */
async function checkDailySendLimit(env: Env, mailbox: string): Promise<string | null> {
  try {
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const row = await env.DB.prepare(
      'SELECT count FROM daily_send_counts WHERE mailbox = ? AND date = ?'
    ).bind(mailbox, today).first<{ count: number }>()

    const dailyLimit = env.DAILY_SEND_LIMIT ? parseInt(env.DAILY_SEND_LIMIT as string, 10) : 100
    if (row && row.count >= dailyLimit) {
      return `Daily send limit reached (${row.count}/${dailyLimit})`
    }
  } catch (err) {
    // Fail-open: rate limit check failure should not block sending
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('no such table')) {
      console.warn('Rate limit check failed (fail-open, allowing send):', err)
    }
  }
  return null
}

/**
 * Increment the daily send count for a mailbox.
 */
async function incrementDailySendCount(env: Env, mailbox: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  try {
    await env.DB.prepare(
      `INSERT INTO daily_send_counts (mailbox, date, count) VALUES (?, ?, 1)
       ON CONFLICT (mailbox, date) DO UPDATE SET count = count + 1`
    ).bind(mailbox, today).run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('no such table')) {
      console.warn('Failed to increment daily send count:', err)
    }
  }
}

export function parseFromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1]!.trim() : ''
}

export function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1]! : from
}
