import { parseIncomingEmail } from './mime'
import type { Env } from './types'
import { resolveAuth } from './handlers/auth'
import { handleInbox } from './handlers/inbox'
import { handleGetCode } from './handlers/code'
import { handleGetEmail, handleDeleteEmail } from './handlers/email'
import { handleSend, parseFromName } from './handlers/send'
import { handleGetAttachment } from './handlers/attachment'
import { handleGetThreads, handleGetThread } from './handlers/threads'
import { handleExtract } from './handlers/extract'
import { getWebhookUrl } from './handlers/webhook'
import { handleEvents } from './handlers/events'
import { handleResendWebhook } from './handlers/delivery-status'
import { handleResendInbound, ingestParsedInbound } from './handlers/inbound'
import { handleDomains } from './handlers/domains'
import { handleClaimAuto } from './handlers/claim'
import { handleMailbox, handleMailboxPause, handleMailboxResume } from './handlers/mailbox'
import { handleWebhookRoutes } from './handlers/webhook-routes'

export type { Env } from './types'

/**
 * Method whitelist per route. Enforces that read-only endpoints reject
 * write methods (e.g. POST /v1/me would previously return 200).
 */
const ROUTE_METHODS: Record<string, string[]> = {
  '/api/inbox': ['GET'],
  '/api/code': ['GET'],
  '/api/email': ['GET', 'DELETE'],
  '/api/send': ['POST'],
  '/api/me': ['GET'],
  '/api/attachment': ['GET'],
  '/api/threads': ['GET'],
  '/api/thread': ['GET'],
  '/api/search': ['GET'],
  '/api/extract': ['POST'],
  '/api/events': ['GET'],
  '/api/domains': ['GET', 'POST'],
  '/api/stats': ['GET'],
  '/api/claim/auto': ['POST'],
  '/api/mailbox': ['GET', 'PATCH', 'DELETE'],
  '/api/mailbox/pause': ['PATCH'],
  '/api/mailbox/resume': ['PATCH'],
  '/api/mailbox/routes': ['GET', 'PUT', 'DELETE'],
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    let response: Response

    // /health is always public
    if (url.pathname === '/health') {
      response = await handleHealth(env)
    } else if (url.pathname === '/api/resend-webhook' && request.method === 'POST') {
      // Resend delivery status callbacks — public endpoint, verified by Resend secret
      response = await handleResendWebhook(request, env, ctx)
    } else if (url.pathname === '/api/resend-inbound' && request.method === 'POST') {
      // Resend Inbound (email.received) — public endpoint, verified by Resend secret
      response = await handleResendInbound(request, env, ctx)
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

        // Method enforcement: reject write methods on read-only routes and vice versa.
        // Subpath routes (/api/domains/:id) are handled separately in the default case.
        const routeBase = route.startsWith('/api/domains/') ? null : route
        const allowedMethods = routeBase ? ROUTE_METHODS[routeBase] : null
        const methodAllowed = !allowedMethods || allowedMethods.includes(request.method)

        // /v1/* always requires mailbox binding (except /v1/me and /v1/claim/auto)
        if (isV1 && !mailbox && route !== '/api/me' && route !== '/api/claim/auto') {
          response = Response.json({ error: 'Unauthorized' }, { status: 401 })
        } else if (!methodAllowed) {
          response = Response.json(
            { error: `Method ${request.method} not allowed for ${url.pathname}. Allowed: ${allowedMethods!.join(', ')}` },
            { status: 405, headers: { 'Allow': allowedMethods!.join(', ') } }
          )
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

      // Prefer the RFC5322 From header (real sender) over the envelope return-path.
      // Cloudflare Email Routing / Resend rewrite the envelope, so `message.from`
      // often points to an amazonses.com bounce address. For display and filtering,
      // users want the actual sender.
      const realFrom = parsed.fromAddress ?? from
      const fromName = parsed.fromName || parseFromName(message.headers.get('from') ?? from)

      // Stages 4-5 + side effects (insert, attachments, labels, events, webhook,
      // embedding) are shared with the Resend Inbound path.
      await ingestParsedInbound(env, ctx, {
        id,
        mailbox: to,
        realFrom,
        fromName,
        envelopeFrom: from,
        subject,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        headers: parsed.headers,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        attachments: parsed.attachments,
        attachmentCount: parsed.attachmentCount,
        attachmentNames: parsed.attachmentNames,
        attachmentSearchText: parsed.attachmentSearchText,
        rawKey,
        source: 'cf-email',
      })
    } catch (err) {
      // Stage 3/4 failed — record failure in ingest log (raw email is safe in R2)
      console.error(`Email processing failed for id=${id} to=${to} envelope=${from}:`, err)
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
        console.log(`Raw cleanup: deleted ${cleanedIds.length} raw email blobs older than 30 days`)
      } catch (err) {
        console.error('Raw email cleanup failed:', err)
      }
    }
  },
} satisfies ExportedHandler<Env>

async function handleHealth(env: Env): Promise<Response> {
  const checks: Record<string, boolean> = {
    db: false,
    attachments: Boolean(env.ATTACHMENTS),
    ai: Boolean(env.AI),
    vectorize: Boolean(env.VECTORIZE),
  }

  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    checks.db = row?.ok === 1
  } catch (err) {
    console.error('Health check failed:', err)
  }

  const healthy = checks.db
  return Response.json(
    {
      ok: healthy,
      status: healthy ? 'ok' : 'unhealthy',
      service: 'mails-worker',
      checks,
    },
    { status: healthy ? 200 : 503 }
  )
}

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
