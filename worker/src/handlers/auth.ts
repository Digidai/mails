import type { AuthContext, Env } from '../types'
import { timingSafeEqual } from './resend-sig'
import { tokenSubjectId } from './privacy'

/**
 * Resolve auth context from request.
 *
 * Auth model:
 *   - If AUTH_TOKENS is set (D1 table mode): look up token → mailbox binding
 *   - If AUTH_TOKEN is set (legacy single-token mode): any valid token, no mailbox binding
 *   - If neither: reject by default. Set ALLOW_PUBLIC_API=true only for local/dev
 *
 * Returns null if auth is required but token is invalid/missing.
 */
export async function resolveAuth(request: Request, env: Env, requireTokenTable = false): Promise<AuthContext | null> {
  const token = extractBearerToken(request)

  // D1 auth_tokens table mode (preferred, supports mailbox isolation)
  const hasAuthTokensTable = await checkAuthTokensTable(env)
  if (hasAuthTokensTable) {
    if (!token) return null
    try {
      // Prefer the current least-privilege schema, including token expiry.
      const row = await env.DB.prepare(
        'SELECT mailbox, scope, expires_at FROM auth_tokens WHERE token = ?'
      ).bind(token).first<{ mailbox: string; scope?: string; expires_at?: string | null }>()
      if (!row) return null
      if (row.expires_at) {
        const expiresAt = Date.parse(row.expires_at)
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
      }
      return {
        mailbox: row.mailbox,
        scope: normalizeStoredScope(row.scope),
        expiresAt: row.expires_at ?? null,
        subjectId: await tokenSubjectId(token, env),
      }
    } catch {
      // Older D1 schemas are treated as mailbox-scoped, never as operators.
      const row = await env.DB.prepare(
        'SELECT mailbox FROM auth_tokens WHERE token = ?'
      ).bind(token).first<{ mailbox: string }>()
      if (!row) return null
      return {
        mailbox: row.mailbox,
        scope: 'mailbox',
        expiresAt: null,
        subjectId: await tokenSubjectId(token, env),
      }
    }
  }

  // /v1/* routes always require auth_tokens table — no fallback
  if (requireTokenTable) {
    return null
  }

  // Legacy single AUTH_TOKEN mode (no mailbox isolation)
  if (env.AUTH_TOKEN) {
    if (!token || !timingSafeEqual(token, env.AUTH_TOKEN)) return null
    return {
      mailbox: null,
      scope: 'operator',
      expiresAt: null,
      subjectId: await tokenSubjectId(token, env),
    }
  }

  // No auth configured — fail closed by default. Public API mode is an
  // explicit local/dev escape hatch to avoid accidentally exposing a Worker.
  if (env.ALLOW_PUBLIC_API === 'true') {
    return {
      mailbox: null,
      scope: 'operator',
      expiresAt: null,
      subjectId: 'local-public-api',
    }
  }

  return null
}

function normalizeStoredScope(scope: string | undefined): AuthContext['scope'] {
  if (scope === 'operator' || scope === 'provisional') return scope
  // Legacy "full", NULL, and unknown values are all mailbox-scoped. Operator
  // rights must be granted explicitly; they are never inferred from defaults.
  return 'mailbox'
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
    return true
  } catch {
    // Do NOT memoize the negative: a transient D1 error must not pin this isolate
    // into legacy/public auth for its lifetime. Re-check on the next request.
    return false
  }
}

/** Reset the auth_tokens table cache — for testing only. */
export function _resetAuthCache(): void {
  _hasAuthTokensTable = null
}
