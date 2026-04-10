import { extractCode } from './extract-code'
import { parseIncomingEmail } from './mime'
import { attachmentContentToUint8Array } from './mime'
import type { Env } from './types'
import { resolveAuth } from './handlers/auth'
import { handleInbox } from './handlers/inbox'
import { handleGetCode } from './handlers/code'
import { handleGetEmail, handleDeleteEmail } from './handlers/email'
import { handleSend, parseFromName } from './handlers/send'
import { handleGetAttachment } from './handlers/attachment'
import { handleGetThreads, handleGetThread } from './handlers/threads'
import { handleExtract } from './handlers/extract'
import { fireWebhookWithRetry, getWebhookUrl } from './handlers/webhook'
import { handleEvents, recordEvent } from './handlers/events'
import { handleResendWebhook } from './handlers/delivery-status'
import { handleDomains } from './handlers/domains'
import { handleClaimAuto } from './handlers/claim'
import { handleMailbox, handleMailboxPause, handleMailboxResume } from './handlers/mailbox'
import { handleWebhookRoutes } from './handlers/webhook-routes'
import { resolveThreadId } from './threading'
import { detectLabels } from './auto-label'
import { generateAndStoreEmbedding } from './embeddings'

export type { Env } from './types'

const R2_UPLOAD_THRESHOLD = 100_000 // 100KB
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024 // 100MB
const R2_UPLOAD_TIMEOUT = 30_000 // 30s

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    let response: Response

    // /health is always public
    if (url.pathname === '/health') {
      response = Response.json({ ok: true })
    } else if (url.pathname === '/api/resend-webhook' && request.method === 'POST') {
      // Resend delivery status callbacks — public endpoint, verified by Resend secret
      response = await handleResendWebhook(request, env, ctx)
    } else if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
      // /v1/* = hosted API (always requires auth_tokens, mailbox-scoped)
      // /api/* = self-hosted API (supports AUTH_TOKEN, public fallback)
      const isV1 = url.pathname.startsWith('/v1/')
      const route = isV1 ? url.pathname.replace('/v1/', '/api/') : url.pathname

      const auth = await resolveAuth(request, env, isV1)
      if (auth === null) {
        response = Response.json({ error: 'Unauthorized' }, { status: 401 })
      } else {
        // Check if mailbox is paused (allow mailbox management endpoints through)
        let paused = false
        const mailboxMgmtRoutes = ['/api/mailbox', '/api/mailbox/pause', '/api/mailbox/resume']
        if (auth.mailbox && !mailboxMgmtRoutes.includes(route)) {
          paused = await checkMailboxStatus(env, auth.mailbox)
        }

        // When mailbox is known from token, use it; otherwise fall through to ?to= param
        const mailbox = auth.mailbox ?? undefined

        // /v1/* always requires mailbox binding (except /v1/me and /v1/claim/auto)
        if (isV1 && !mailbox && route !== '/api/me' && route !== '/api/claim/auto') {
          response = Response.json({ error: 'Unauthorized' }, { status: 401 })
        } else if (paused) {
          response = Response.json({ error: 'Mailbox is paused' }, { status: 403 })
        } else {
          try {
            switch (route) {
              case '/api/inbox':
                response = await handleInbox(url, env, mailbox)
                break
              case '/api/code':
                response = await handleGetCode(url, env, mailbox)
                break
              case '/api/email':
                if (request.method === 'DELETE') {
                  response = await handleDeleteEmail(url, env, mailbox)
                } else {
                  response = await handleGetEmail(url, env, mailbox)
                }
                break
              case '/api/send':
                if (request.method !== 'POST') {
                  response = Response.json({ error: 'Method not allowed' }, { status: 405 })
                  break
                }
                response = await handleSend(request, env, mailbox, ctx)
                break
              case '/api/me':
                response = Response.json({
                  worker: 'mails-worker',
                  mailbox: mailbox ?? null,
                  send: !!env.RESEND_API_KEY,
                })
                break
              case '/api/attachment':
                response = await handleGetAttachment(url, env, mailbox)
                break
              case '/api/threads':
                response = await handleGetThreads(url, env, mailbox)
                break
              case '/api/thread':
                response = await handleGetThread(url, env, mailbox)
                break
              case '/api/search':
                // Alias: ?q= → ?query=, default mode=hybrid
                if (!url.searchParams.has('query') && url.searchParams.has('q')) {
                  url.searchParams.set('query', url.searchParams.get('q')!)
                }
                if (!url.searchParams.has('mode')) {
                  url.searchParams.set('mode', 'hybrid')
                }
                response = await handleInbox(url, env, mailbox)
                break
              case '/api/extract':
                if (request.method !== 'POST') {
                  response = Response.json({ error: 'Method not allowed' }, { status: 405 })
                  break
                }
                response = await handleExtract(request, url, env, mailbox)
                break
              case '/api/events':
                response = handleEvents(url, env, mailbox)
                break
              case '/api/domains':
                response = await handleDomains(request, url, env, mailbox)
                break
              case '/api/stats': {
                const mb = mailbox ?? url.searchParams.get('to') ?? ''
                if (!mb) {
                  response = Response.json({ error: 'Mailbox required' }, { status: 400 })
                  break
                }
                const total = await env.DB.prepare(
                  'SELECT COUNT(*) as total, SUM(CASE WHEN direction = ? THEN 1 ELSE 0 END) as inbound, SUM(CASE WHEN direction = ? THEN 1 ELSE 0 END) as outbound FROM emails WHERE mailbox = ?'
                ).bind('inbound', 'outbound', mb).first<{ total: number; inbound: number; outbound: number }>()
                const thisMonth = new Date()
                thisMonth.setDate(1)
                thisMonth.setHours(0, 0, 0, 0)
                const monthly = await env.DB.prepare(
                  'SELECT COUNT(*) as count FROM emails WHERE mailbox = ? AND received_at >= ?'
                ).bind(mb, thisMonth.toISOString()).first<{ count: number }>()
                // Extended stats: ingest log, suppression, webhook routes
                let ingestStats = { pending: 0, parsed: 0, failed: 0 }
                let suppressionCount = 0
                let routesCount = 0
                try {
                  const ingest = await env.DB.prepare(
                    "SELECT status, COUNT(*) as count FROM ingest_log WHERE mailbox = ? GROUP BY status"
                  ).bind(mb).all<{ status: string; count: number }>()
                  for (const row of ingest.results ?? []) {
                    if (row.status === 'pending') ingestStats.pending = row.count
                    else if (row.status === 'parsed') ingestStats.parsed = row.count
                    else if (row.status === 'failed') ingestStats.failed = row.count
                  }
                } catch { /* table may not exist */ }
                try {
                  const sup = await env.DB.prepare('SELECT COUNT(*) as count FROM suppression_list').first<{ count: number }>()
                  suppressionCount = sup?.count ?? 0
                } catch { /* table may not exist */ }
                try {
                  const routes = await env.DB.prepare('SELECT COUNT(*) as count FROM webhook_routes WHERE mailbox = ?').bind(mb).first<{ count: number }>()
                  routesCount = routes?.count ?? 0
                } catch { /* table may not exist */ }
                response = Response.json({
                  mailbox: mb,
                  total_emails: total?.total ?? 0,
                  inbound: total?.inbound ?? 0,
                  outbound: total?.outbound ?? 0,
                  emails_this_month: monthly?.count ?? 0,
                  ingest: ingestStats,
                  suppression_count: suppressionCount,
                  webhook_routes: routesCount,
                })
                break
              }
              case '/api/claim/auto':
                response = await handleClaimAuto(request, env, auth)
                break
              case '/api/mailbox':
                response = await handleMailbox(request, env, mailbox)
                break
              case '/api/mailbox/pause':
                response = await handleMailboxPause(request, env, mailbox)
                break
              case '/api/mailbox/resume':
                response = await handleMailboxResume(request, env, mailbox)
                break
              case '/api/mailbox/routes':
                response = await handleWebhookRoutes(request, url, env, mailbox)
                break
              default:
                // Handle sub-path routes: /api/domains/:id, /api/domains/:id/verify
                if (route.startsWith('/api/domains/')) {
                  response = await handleDomains(request, url, env, mailbox)
                } else {
                  response = Response.json({ error: 'Not found' }, { status: 404 })
                }
            }
          } catch (err) {
            console.error(`API error ${url.pathname}:`, err)
            // Never expose internal error details to clients
            response = Response.json(
              { error: 'Internal server error' },
              { status: 500 }
            )
          }
        }
      }
    } else {
      response = Response.json({ name: 'mails-worker' })
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value)
    }
    return response
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const to = message.to
    const from = message.from
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const date = now.slice(0, 10) // YYYY-MM-DD

    // Stage 1: Raw-first persistence — store raw MIME to R2 before any parsing
    // This ensures no email is lost even if parsing fails
    let rawKey: string | null = null
    if (env.ATTACHMENTS) {
      rawKey = `raw/${to}/${date}/${id}`
      try {
        await env.ATTACHMENTS.put(rawKey, message.raw)
      } catch (err) {
        console.warn(`R2 raw upload failed for ${rawKey} (degraded mode):`, err)
        rawKey = null // Continue without raw backup
      }
    }

    // Stage 2: Record ingestion in manifest (tracks state across stages)
    try {
      await env.DB.prepare(
        'INSERT INTO ingest_log (id, mailbox, raw_key, status, from_address, to_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, to, rawKey ?? '', 'pending', from, to, now).run()
    } catch (err) {
      console.warn(`Ingest log insert failed for ${id} (continuing):`, err)
    }

    try {
      // Stage 3: Parse email
      const parsed = await parseIncomingEmail(await new Response(message.raw).arrayBuffer(), id, now)
      const subject = parsed.subject || message.headers.get('subject') || ''
      const code = extractCode(`${subject} ${parsed.bodyText}`)
      const fromName = parseFromName(message.headers.get('from') ?? from)

      // Threading: resolve thread_id from In-Reply-To / References headers
      const threadId = await resolveThreadId(parsed.inReplyTo, parsed.references, parsed.messageId, env.DB, to)

      // Auto-labeling
      const labels = detectLabels(from, parsed.headers, code)

      // Upload large attachments to R2
      for (const att of parsed.attachments) {
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

      // Stage 4: Insert email into D1 (with idempotency via UNIQUE on mailbox+message_id)
      const statements = [
        env.DB.prepare(`
          INSERT OR IGNORE INTO emails (
            id, mailbox, from_address, from_name, to_address, subject,
            body_text, body_html, code, headers, metadata, message_id,
            thread_id, in_reply_to, "references",
            has_attachments, attachment_count, attachment_names, attachment_search_text,
            raw_storage_key, direction, status, received_at, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?)
        `).bind(
          id, to, from, fromName, to, subject,
          parsed.bodyText.slice(0, 50000),
          parsed.bodyHtml.slice(0, 100000),
          code,
          JSON.stringify(parsed.headers),
          JSON.stringify({}),
          parsed.messageId,
          threadId,
          parsed.inReplyTo,
          parsed.references,
          parsed.attachmentCount > 0 ? 1 : 0,
          parsed.attachmentCount,
          parsed.attachmentNames,
          parsed.attachmentSearchText,
          rawKey, now, now
        ),
        ...parsed.attachments.map((attachment) =>
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
            attachment.created_at
          )
        ),
      ]

      await env.DB.batch(statements)

      // Stage 5: Update ingest log to parsed
      try {
        await env.DB.prepare(
          'UPDATE ingest_log SET status = ?, email_id = ? WHERE id = ?'
        ).bind('parsed', id, id).run()
      } catch (err) {
        console.warn(`Ingest log update failed for ${id}:`, err)
      }

      console.log(`Email received id=${id} to=${to} from=${from} subject="${subject.slice(0, 50)}" thread=${threadId.slice(0, 8)} labels=${labels.join(',')} attachments=${parsed.attachmentCount}`)

      // Insert auto-labels (separate batch — label failure should not block email storage)
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

      // Record SSE event (non-blocking)
      const eventPayload = {
        event: 'message.received',
        email_id: id,
        mailbox: to,
        from,
        subject,
        received_at: now,
        message_id: parsed.messageId,
        thread_id: threadId,
        labels,
        has_attachments: parsed.attachmentCount > 0,
        attachment_count: parsed.attachmentCount,
      }
      ctx.waitUntil(recordEvent(env, 'message.received', to, eventPayload))

      // Fire webhook with retry (non-blocking via waitUntil)
      ctx.waitUntil(fireWebhookWithRetry(env, to, eventPayload))

      // Generate embedding for semantic search (non-blocking)
      ctx.waitUntil(
        generateAndStoreEmbedding(env, id, to, subject, fromName, parsed.bodyText)
      )
    } catch (err) {
      // Stage 3/4 failed — record failure in ingest log (raw email is safe in R2)
      console.error(`Email processing failed for id=${id} to=${to} from=${from}:`, err)
      try {
        const errorMsg = err instanceof Error ? err.message : String(err)
        await env.DB.prepare(
          'UPDATE ingest_log SET status = ?, error_message = ? WHERE id = ?'
        ).bind('failed', errorMsg.slice(0, 1000), id).run()
      } catch (logErr) {
        console.error(`Ingest log failure update failed for ${id}:`, logErr)
      }
    }
  },
  // Scheduled handler: clean up old events + raw emails (runs hourly via cron trigger)
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Clean up SSE events older than 24 hours
    const eventCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    try {
      const result = await env.DB.prepare('DELETE FROM events WHERE created_at < ?').bind(eventCutoff).run()
      console.log(`Events cleanup: deleted ${result.meta.changes ?? 0} events older than ${eventCutoff}`)
    } catch (err) {
      console.error('Events cleanup failed:', err)
    }

    // Clean up raw email blobs older than 30 days (only for successfully parsed emails)
    if (env.ATTACHMENTS) {
      const rawCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      try {
        const parsed = await env.DB.prepare(
          'SELECT id, raw_key FROM ingest_log WHERE status = ? AND created_at < ? AND raw_key != ?'
        ).bind('parsed', rawCutoff, '').all<{ id: string; raw_key: string }>()
        const cleanedIds: string[] = []
        for (const row of parsed.results ?? []) {
          try {
            await env.ATTACHMENTS.delete(row.raw_key)
            cleanedIds.push(row.id)
          } catch {
            // R2 delete failures are non-critical — retry next cron run
          }
        }
        // Remove only ingest_log entries whose R2 blobs were successfully deleted
        for (const cleanedId of cleanedIds) {
          await env.DB.prepare('DELETE FROM ingest_log WHERE id = ?').bind(cleanedId).run()
        }
        console.log(`Raw cleanup: deleted ${deleted} raw email blobs older than 30 days`)
      } catch (err) {
        console.error('Raw email cleanup failed:', err)
      }
    }
  },
} satisfies ExportedHandler<Env>

/**
 * Check if a mailbox is paused. Returns true if paused, false otherwise.
 * Gracefully handles missing 'status' column.
 */
async function checkMailboxStatus(env: Env, mailbox: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT status FROM auth_tokens WHERE mailbox = ? LIMIT 1'
    ).bind(mailbox).first<{ status: string | null }>()
    return row?.status === 'paused'
  } catch {
    // status column may not exist yet — treat as active
    return false
  }
}
