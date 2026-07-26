import type { Env } from '../types'
import { recordFunnelEvent } from './funnel'
import {
  getClientIp,
  getClientMetadata,
  hmacIdentifier,
  readNonNegativeInt,
  tokenSubjectId,
} from './privacy'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/
const DEFAULT_TTL_HOURS = 72
const DEFAULT_IP_DAILY_LIMIT = 1
const DEFAULT_GLOBAL_DAILY_LIMIT = 100

type ExistingGrant = {
  mailbox: string
  token: string
  expires_at: string
}

export async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' })
  }
  if (env.BOOTSTRAP_ENABLED !== 'true') {
    return json({ error: 'Provisional mailbox bootstrap is disabled' }, 404)
  }
  if (!isAllowedOrigin(request, env)) {
    return json({ error: 'Browser origin is not allowed to create a provisional mailbox' }, 403)
  }
  if (!env.ABUSE_HASH_SECRET) {
    console.error('[bootstrap] ABUSE_HASH_SECRET is required')
    return json({ error: 'Service temporarily unavailable' }, 503)
  }

  const idempotencyKey = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return json(
      { error: 'A 16-128 character Idempotency-Key header is required' },
      400,
    )
  }

  const ip = getClientIp(request)
  if (!ip) {
    return json({ error: 'Unable to establish a trusted network principal' }, 400)
  }

  const principalHash = await hmacIdentifier(`bootstrap-ip:${ip}`, env.ABUSE_HASH_SECRET)
  const idempotencyHash = await hmacIdentifier(
    `bootstrap-idempotency:${principalHash}:${idempotencyKey}`,
    env.ABUSE_HASH_SECRET,
  )
  const metadata = getClientMetadata(request)
  await recordFunnelEvent(env, 'bootstrap_started', idempotencyHash, {
    ...metadata,
    flow: 'provisional',
  })

  const replay = await findGrant(env, idempotencyHash)
  if (replay && Date.parse(replay.expires_at) > Date.now()) {
    return bootstrapResponse(replay.mailbox, replay.token, replay.expires_at, true)
  }

  const limitResponse = await enforceLimits(env, principalHash)
  if (limitResponse) {
    let errorCode = 'bootstrap_rate_limited'
    try {
      const body = await limitResponse.clone().json() as { code?: string }
      errorCode = body.code ?? errorCode
    } catch {
      // Keep the generic code when an error response is not JSON.
    }
    await recordFunnelEvent(env, 'bootstrap_failed', idempotencyHash, {
      ...metadata,
      flow: 'provisional',
      outcome: 'failure',
      errorCode,
    })
    return limitResponse
  }

  // A deleted or expired mailbox leaves its grant ledger behind so it still
  // counts toward the daily quota. Once quota admission succeeds, replace a
  // stale row carrying the same idempotency hash.
  try {
    await env.DB.prepare('DELETE FROM bootstrap_grants WHERE idempotency_hash = ?')
      .bind(idempotencyHash)
      .run()
  } catch (error) {
    console.error('[bootstrap] stale replay cleanup failed:', error instanceof Error ? error.message : String(error))
    return json({ error: 'Service temporarily unavailable' }, 503)
  }

  const now = new Date()
  const ttlHours = Math.max(1, Math.min(168, readNonNegativeInt(
    env.PROVISIONAL_TTL_HOURS,
    DEFAULT_TTL_HOURS,
  )))
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString()
  const token = `mk_${randomHex(32)}`

  for (let attempt = 0; attempt < 4; attempt++) {
    const mailbox = `agent-${randomHex(6)}@mails0.com`
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO auth_tokens (
            token, mailbox, created_at, scope, status, send_unlocks_at, expires_at
          ) VALUES (?, ?, ?, 'provisional', 'active', NULL, ?)`
        ).bind(token, mailbox, now.toISOString(), expiresAt),
        env.DB.prepare(
          `INSERT INTO bootstrap_grants (
            idempotency_hash, principal_hash, token, mailbox, source,
            client_name, client_version, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          idempotencyHash,
          principalHash,
          token,
          mailbox,
          metadata.source,
          metadata.clientName,
          metadata.clientVersion,
          now.toISOString(),
          expiresAt,
        ),
      ])

      await recordFunnelEvent(env, 'bootstrap_completed', await tokenSubjectId(token, env), {
        ...metadata,
        flow: 'provisional',
      })
      return bootstrapResponse(mailbox, token, expiresAt, false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('unique') && attempt < 3) continue
      console.error('[bootstrap] grant creation failed:', message)
      await recordFunnelEvent(env, 'bootstrap_failed', idempotencyHash, {
        ...metadata,
        flow: 'provisional',
        outcome: 'failure',
        errorCode: 'grant_creation_failed',
      })
      return json({ error: 'Service temporarily unavailable' }, 503)
    }
  }

  return json({ error: 'Service temporarily unavailable' }, 503)
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  const configured = env.BOOTSTRAP_ALLOWED_ORIGINS
    ?? 'https://mails0.com,https://www.mails0.com'
  return configured
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin)
}

async function findGrant(env: Env, idempotencyHash: string): Promise<ExistingGrant | null> {
  try {
    return await env.DB.prepare(
      `SELECT g.mailbox, g.token, g.expires_at
       FROM bootstrap_grants g
       JOIN auth_tokens a ON a.token = g.token
       WHERE g.idempotency_hash = ?
         AND a.status = 'active'
         AND (a.expires_at IS NULL OR datetime(a.expires_at) > datetime('now'))
       LIMIT 1`
    ).bind(idempotencyHash).first<ExistingGrant>()
  } catch (error) {
    console.error('[bootstrap] replay lookup failed:', error instanceof Error ? error.message : String(error))
    return null
  }
}

async function enforceLimits(env: Env, principalHash: string): Promise<Response | null> {
  const ipLimit = readNonNegativeInt(env.BOOTSTRAP_IP_DAILY_LIMIT, DEFAULT_IP_DAILY_LIMIT)
  const globalLimit = readNonNegativeInt(
    env.BOOTSTRAP_GLOBAL_DAILY_LIMIT,
    DEFAULT_GLOBAL_DAILY_LIMIT,
  )
  const now = new Date()
  const date = now.toISOString().slice(0, 10)

  try {
    if (ipLimit > 0 && !await consumeDailyQuota(
      env,
      `principal:${date}:${principalHash}`,
      date,
      ipLimit,
      now.toISOString(),
    )) {
      return json(
        {
          error: 'This network has reached its provisional mailbox limit for today. Reuse the existing mailbox or claim a permanent one.',
          code: 'provisional_daily_limit',
        },
        429,
        { 'Retry-After': '3600' },
      )
    }

    if (globalLimit > 0 && !await consumeDailyQuota(
      env,
      `global:${date}`,
      date,
      globalLimit,
      now.toISOString(),
    )) {
      return json(
        { error: 'Provisional mailbox capacity reached. Try again later.', code: 'global_bootstrap_limit' },
        429,
        { 'Retry-After': '3600' },
      )
    }
  } catch (error) {
    console.error('[bootstrap] rate limit failed:', error instanceof Error ? error.message : String(error))
    return json({ error: 'Unable to verify bootstrap safety. Try again later.' }, 503)
  }

  return null
}

async function consumeDailyQuota(
  env: Env,
  bucketKey: string,
  date: string,
  limit: number,
  now: string,
): Promise<boolean> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bootstrap_quota_buckets (
      bucket_key, bucket_date, count, updated_at
    ) VALUES (?, ?, 0, ?)`
  ).bind(bucketKey, date, now).run()
  const result = await env.DB.prepare(
    `UPDATE bootstrap_quota_buckets
     SET count = count + 1, updated_at = ?
     WHERE bucket_key = ? AND count < ?`
  ).bind(now, bucketKey, limit).run()
  return (result.meta.changes ?? 0) === 1
}

function bootstrapResponse(
  mailbox: string,
  token: string,
  expiresAt: string,
  replayed: boolean,
): Response {
  return json({
    mailbox,
    api_key: token,
    scope: 'provisional',
    expires_at: expiresAt,
    replayed,
    capabilities: ['inbox.read', 'email.read', 'code.read', 'search.read', 'threads.read'],
    upgrade: {
      command: 'mails claim <name>',
      url: 'https://mails0.com',
    },
  }, replayed ? 200 : 201)
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
