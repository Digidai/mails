import type { Env, AuthContext } from '../types'

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

  await env.DB.prepare(
    'INSERT INTO auth_tokens (token, mailbox, created_at) VALUES (?, ?, ?)'
  ).bind(apiKey, mailbox, now).run()

  return Response.json({ mailbox, api_key: apiKey }, { status: 201 })
}

function generateToken(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export { RESERVED_NAMES }
