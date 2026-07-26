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
import { handleEvents } from './handlers/events'
import { handleResendWebhook } from './handlers/delivery-status'
import {
  handleResendInbound,
  ingestParsedInbound,
  resolveInboundRecipient,
} from './handlers/inbound'
import { handleDomains } from './handlers/domains'
import { handleClaimAuto } from './handlers/claim'
import { handleBootstrap } from './handlers/bootstrap'
import {
  deleteMailboxData,
  handleMailbox,
  handleMailboxPause,
  handleMailboxResume,
} from './handlers/mailbox'
import { handleWebhookRoutes } from './handlers/webhook-routes'
import { checkAuthFailureBlock, recordAuthFailure } from './handlers/auth-abuse'
import { recordFunnelEvent } from './handlers/funnel'
import { getClientMetadata } from './handlers/privacy'

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
  '/api/bootstrap': ['POST'],
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
      'Access-Control-Allow-Headers': [
        'Content-Type',
        'Authorization',
        'Idempotency-Key',
        'X-Mails-Client',
        'X-Mails-Client-Version',
        'X-Mails-Source',
        'X-Mails-Flow',
      ].join(', '),
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
    } else if (url.pathname === '/v1/bootstrap') {
      // Agent-native first run: random, expiring, receive-only mailbox.
      response = await handleBootstrap(request, env)
    } else if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
      // /v1/* = hosted API (always requires auth_tokens, mailbox-scoped)
      // /api/* = self-hosted API (supports AUTH_TOKEN, public fallback)
      const isV1 = url.pathname.startsWith('/v1/')
      const route = isV1 ? url.pathname.replace('/v1/', '/api/') : url.pathname

      const authBlock = isV1
        ? await checkAuthFailureBlock(request, env)
        : { principalHash: null, retryAfter: null }
      if (authBlock.retryAfter) {
        response = Response.json(
          { error: 'Too many invalid authentication attempts', code: 'auth_rate_limited' },
          { status: 429, headers: { 'Retry-After': String(authBlock.retryAfter) } },
        )
      } else {
        const auth = await resolveAuth(request, env, isV1)
        if (auth === null) {
          if (isV1) ctx.waitUntil(recordAuthFailure(env, authBlock.principalHash))
          response = Response.json(
            { error: 'Unauthorized', code: 'invalid_or_expired_token' },
            { status: 401 },
          )
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
        } else if (
          isV1
          && auth.scope === 'provisional'
          && !isProvisionalRouteAllowed(route, request.method)
        ) {
          response = Response.json(
            {
              error: 'This provisional mailbox is receive-only. Claim a permanent mailbox to unlock this capability.',
              code: 'provisional_capability_denied',
              upgrade: 'mails claim <name>',
            },
            { status: 403 },
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
                  scope: auth.scope,
                  expires_at: auth.expiresAt,
                  send: auth.scope !== 'provisional' && !!env.RESEND_API_KEY,
                  capabilities: capabilitiesForScope(auth.scope),
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
                // Moderation actions are operator-only: a mailbox-scoped token
                // must not be able to pause/resume (esp. self-resume after an
                // operator pause, which would defeat abuse enforcement).
                if (auth.scope !== 'operator') {
                  response = Response.json({ error: 'Forbidden' }, { status: 403 })
                  break
                }
                response = await handleMailboxPause(request, env, mailbox)
                break
              case '/api/mailbox/resume':
                if (auth.scope !== 'operator') {
                  response = Response.json({ error: 'Forbidden' }, { status: 403 })
                  break
                }
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
        if (isV1 && response.ok) {
          const metadata = getClientMetadata(request)
          ctx.waitUntil(recordFunnelEvent(env, 'first_api_success', auth.subjectId, metadata))
          if (route === '/api/inbox') {
            ctx.waitUntil(recordFunnelEvent(env, 'first_inbox_read', auth.subjectId, metadata))
          } else if (route === '/api/code') {
            const codeResponse = response.clone()
            ctx.waitUntil((async () => {
              try {
                const body = await codeResponse.json() as { code?: string | null }
                if (body.code) {
                  await recordFunnelEvent(env, 'first_code_retrieved', auth.subjectId, metadata)
                }
              } catch {
                // Non-JSON responses are never considered successful code retrievals.
              }
            })())
          }
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
    const recipient = await resolveInboundRecipient(env, to)
    if (!recipient.accepted) {
      console.warn(`Inbound email rejected for inactive or unknown mailbox to=${to}`)
      message.setReject('Unknown or inactive mailbox')
      return
    }
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
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Expired provisional mailboxes are ephemeral by contract. Remove their
    // messages, attachment blobs, routes, counters, grants, and token.
    try {
      const expired = await env.DB.prepare(
        `SELECT mailbox FROM auth_tokens
         WHERE scope = 'provisional'
           AND expires_at IS NOT NULL
           AND datetime(expires_at) <= datetime('now')
         LIMIT 100`
      ).all<{ mailbox: string }>()
      for (const row of expired.results ?? []) {
        await deleteMailboxData(env, row.mailbox)
      }
      if ((expired.results ?? []).length > 0) {
        console.log(`Provisional cleanup: deleted ${(expired.results ?? []).length} expired mailboxes`)
      }
    } catch (error) {
      console.error('Provisional mailbox cleanup failed:', error)
    }

    // Clean up SSE events older than 24 hours
    const eventCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    try {
      const result = await env.DB.prepare('DELETE FROM events WHERE created_at < ?').bind(eventCutoff).run()
      console.log(`Events cleanup: deleted ${result.meta.changes ?? 0} events older than ${eventCutoff}`)
    } catch (err) {
      console.error('Events cleanup failed:', err)
    }

    // Funnel data is aggregate product telemetry with no raw addresses, IPs, or
    // tokens. Keep a bounded 180-day window.
    const funnelCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
    try {
      await env.DB.prepare('DELETE FROM funnel_events WHERE created_at < ?').bind(funnelCutoff).run()
    } catch (err) {
      console.error('Funnel cleanup failed:', err)
    }

    // Authentication abuse buckets are useful only for recent throttling.
    const authBucketCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    try {
      await env.DB.prepare('DELETE FROM auth_failure_buckets WHERE last_seen_at < ?').bind(authBucketCutoff).run()
    } catch (err) {
      console.error('Auth failure bucket cleanup failed:', err)
    }

    // Grant rows enforce daily quotas even after a mailbox is deleted. Scrub
    // expired replay tokens promptly, then remove old quota/grant ledgers.
    const grantLedgerCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const quotaDateCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    try {
      await env.DB.prepare(
        "UPDATE bootstrap_grants SET token = '' WHERE token != '' AND datetime(expires_at) <= datetime('now')"
      ).run()
      await env.DB.prepare('DELETE FROM bootstrap_grants WHERE expires_at < ?').bind(grantLedgerCutoff).run()
      await env.DB.prepare('DELETE FROM bootstrap_quota_buckets WHERE bucket_date < ?').bind(quotaDateCutoff).run()
    } catch (err) {
      console.error('Bootstrap ledger cleanup failed:', err)
    }

    // Claim sessions need short-lived replay state and abuse evidence, not
    // indefinite duplicate credentials or network metadata.
    const claimSessionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    try {
      await env.DB.prepare(
        "UPDATE claim_sessions SET api_key = NULL WHERE api_key IS NOT NULL AND datetime(expires_at) <= datetime('now')"
      ).run()
      await env.DB.prepare('DELETE FROM claim_sessions WHERE created_at < ?').bind(claimSessionCutoff).run()
    } catch (err) {
      console.error('Claim session cleanup failed:', err)
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

export async function handleHealth(env: Env): Promise<Response> {
  const checks: Record<string, boolean> = {
    db: false,
    auth_schema: false,
    bootstrap_schema: false,
    funnel_schema: false,
    growth_schema: false,
    bootstrap_config: env.BOOTSTRAP_ENABLED === 'true' && Boolean(env.ABUSE_HASH_SECRET),
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

  const schemaChecks = [
    [
      'auth_schema',
      'SELECT scope, status, send_unlocks_at, expires_at FROM auth_tokens LIMIT 0',
    ],
    [
      'bootstrap_schema',
      'SELECT idempotency_hash, principal_hash, expires_at FROM bootstrap_grants LIMIT 0',
    ],
    [
      'funnel_schema',
      'SELECT event_name, anonymous_id, source FROM funnel_events LIMIT 0',
    ],
    [
      'growth_schema',
      'SELECT event_name, anonymous_id, source FROM growth_events LIMIT 0',
    ],
  ] as const
  for (const [check, query] of schemaChecks) {
    try {
      await env.DB.prepare(query).first()
      checks[check] = true
    } catch (err) {
      console.error(`Health schema check failed (${check}):`, err)
    }
  }

  const healthy = checks.db
    && checks.auth_schema
    && checks.bootstrap_schema
    && checks.funnel_schema
    && checks.growth_schema
    && checks.bootstrap_config
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

export function isProvisionalRouteAllowed(route: string, method: string): boolean {
  if (method === 'DELETE' && route === '/api/mailbox') return true
  if (method === 'GET') {
    return new Set([
      '/api/inbox',
      '/api/code',
      '/api/email',
      '/api/me',
      '/api/threads',
      '/api/thread',
      '/api/search',
      '/api/stats',
      '/api/events',
      '/api/mailbox',
    ]).has(route)
  }
  return method === 'POST' && route === '/api/extract'
}

function capabilitiesForScope(scope: 'operator' | 'mailbox' | 'provisional'): string[] {
  const receive = ['inbox.read', 'email.read', 'code.read', 'search.read', 'threads.read']
  if (scope === 'provisional') return receive
  const mailbox = [...receive, 'email.send', 'attachment.read', 'webhook.manage', 'domain.manage']
  return scope === 'operator'
    ? [...mailbox, 'mailbox.provision', 'mailbox.moderate']
    : mailbox
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
