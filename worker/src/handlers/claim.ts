import type { Env, AuthContext } from '../types'
import { recordEvent } from './events'

/**
 * Reserved name blacklist — names that cannot be claimed as mailboxes.
 * Mirrors the list from mails-web/functions/v1/claim/start.ts.
 */
const RESERVED_NAMES = new Set([
  'admin', 'administrator', 'postmaster', 'webmaster', 'hostmaster',
  'abuse', 'security', 'support', 'help', 'info', 'contact',
  'noreply', 'no-reply', 'mailer-daemon', 'root', 'system',
  'mail', 'mails', 'email', 'test', 'www', 'ftp', 'smtp', 'imap', 'pop',
  'api', 'dev', 'staging', 'production', 'demo',
])

/**
 * POST /v1/claim/auto — headless (pure-API) mailbox claim.
 *
 * Body: { name: string }
 * Requires valid Bearer token (authenticated endpoint).
 * Creates a new mailbox under the authenticated account.
 * Returns { mailbox, api_key } for the new mailbox.
 */
export async function handleClaimAuto(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  // Rate limit: max N claims per token per day (default 5)
  const rateLimitError = await checkDailyClaimLimit(request, env)
  if (rateLimitError) {
    return Response.json({ error: rateLimitError }, { status: 429 })
  }

  let body: { name: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = body.name?.toLowerCase().trim()
  if (!name) {
    return Response.json({ error: 'Missing required field: name' }, { status: 400 })
  }

  // Validate name format
  if (!/^[a-z0-9]([a-z0-9._-]{0,38}[a-z0-9])?$/.test(name)) {
    return Response.json(
      { error: 'Invalid name. Use 1-40 lowercase letters, numbers, dots, hyphens, or underscores.' },
      { status: 400 },
    )
  }

  // Check reserved names
  if (RESERVED_NAMES.has(name)) {
    return Response.json({ error: `Name "${name}" is reserved` }, { status: 400 })
  }

  const mailbox = `${name}@mails0.com`

  // Check if mailbox already exists
  const existing = await env.DB.prepare(
    'SELECT mailbox FROM auth_tokens WHERE mailbox = ?'
  ).bind(mailbox).first()
  if (existing) {
    return Response.json({ error: `Mailbox ${mailbox} is already taken` }, { status: 409 })
  }

  // Generate new API key
  const apiKey = `mk_${generateToken(32)}`
  const now = new Date().toISOString()
  // Send warm-up: brand-new mailboxes can receive/read immediately,
  // but cannot send until 24h after claim. Defends against fresh-mailbox
  // phishing fan-out (see 2026-05-12 incident).
  const warmupHours = readPositiveInt(env.SEND_WARMUP_HOURS, 24)
  const sendUnlocksAt =
    warmupHours > 0 ? new Date(Date.now() + warmupHours * 3600 * 1000).toISOString() : null

  try {
    await env.DB.prepare(
      'INSERT INTO auth_tokens (token, mailbox, created_at, send_unlocks_at) VALUES (?, ?, ?, ?)'
    ).bind(apiKey, mailbox, now, sendUnlocksAt).run()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // Legacy schemas without send_unlocks_at — fall back to the 3-column insert.
    if (msg.includes('no such column') || msg.includes('has no column named')) {
      await env.DB.prepare(
        'INSERT INTO auth_tokens (token, mailbox, created_at) VALUES (?, ?, ?)'
      ).bind(apiKey, mailbox, now).run()
    } else {
      throw e
    }
  }

  // Activation funnel: track mailbox claim
  await recordEvent(env, 'activation.claimed', mailbox, { name, source: 'api' })

  return Response.json({ mailbox, api_key: apiKey }, { status: 201 })
}

function generateToken(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

async function checkDailyClaimLimit(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : 'unknown'
  const today = new Date().toISOString().slice(0, 10)
  const dailyLimit = env.DAILY_CLAIM_LIMIT ? parseInt(env.DAILY_CLAIM_LIMIT as string, 10) : 5

  try {
    await env.DB.prepare(
      `INSERT INTO daily_claim_counts (token, date, count) VALUES (?, ?, 1)
       ON CONFLICT (token, date) DO UPDATE SET count = count + 1`
    ).bind(token, today).run()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('no such table') || msg.includes('SQLITE_ERROR')) {
      return null
    }
    return 'Rate limit check failed — try again'
  }

  const row = await env.DB.prepare(
    'SELECT count FROM daily_claim_counts WHERE token = ? AND date = ?'
  ).bind(token, today).first<{ count: number }>()

  if (row && row.count > dailyLimit) {
    await env.DB.prepare(
      'UPDATE daily_claim_counts SET count = count - 1 WHERE token = ? AND date = ?'
    ).bind(token, today).run()
    return `Daily claim limit reached (${dailyLimit} mailboxes per day)`
  }

  return null
}

export { RESERVED_NAMES }
