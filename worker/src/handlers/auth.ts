import type { AuthContext, Env } from '../types'

/**
 * Resolve auth context from request.
 *
 * Auth model:
 *   - If AUTH_TOKENS is set (D1 table mode): look up token → mailbox binding
 *   - If AUTH_TOKEN is set (legacy single-token mode): any valid token, no mailbox binding
 *   - If neither: no auth required, all endpoints are public
 *
 * Returns null if auth is required but token is invalid/missing.
 */
export async function resolveAuth(request: Request, env: Env, requireTokenTable = false): Promise<AuthContext | null> {
  const token = extractBearerToken(request)

  // D1 auth_tokens table mode (preferred, supports mailbox isolation)
  const hasAuthTokensTable = await checkAuthTokensTable(env)
  if (hasAuthTokensTable) {
    if (!token) return null
    const row = await env.DB.prepare(
      'SELECT mailbox FROM auth_tokens WHERE token = ?'
    ).bind(token).first<{ mailbox: string }>()
    if (!row) return null
    return { mailbox: row.mailbox }
  }

  // /v1/* routes always require auth_tokens table — no fallback
  if (requireTokenTable) {
    return null
  }

  // Legacy single AUTH_TOKEN mode (no mailbox isolation)
  if (env.AUTH_TOKEN) {
    if (!token || token !== env.AUTH_TOKEN) return null
    return { mailbox: null }
  }

  // No auth configured — public access
  return { mailbox: null }
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

let _hasAuthTokensTable: boolean | null = null

async function checkAuthTokensTable(env: Env): Promise<boolean> {
  if (_hasAuthTokensTable !== null) return _hasAuthTokensTable
  try {
    await env.DB.prepare("SELECT 1 FROM auth_tokens LIMIT 0").run()
    _hasAuthTokensTable = true
  } catch {
    _hasAuthTokensTable = false
  }
  return _hasAuthTokensTable
}

/** Reset the auth_tokens table cache — for testing only. */
export function _resetAuthCache(): void {
  _hasAuthTokensTable = null
}
