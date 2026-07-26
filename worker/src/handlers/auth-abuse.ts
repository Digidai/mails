import type { Env } from '../types'
import { getClientIp, hmacIdentifier, readNonNegativeInt } from './privacy'

const DEFAULT_FAILURE_LIMIT = 12
const DEFAULT_BLOCK_MINUTES = 60
const WINDOW_MS = 60 * 60 * 1000

type FailureBucket = {
  window_started_at: string
  failure_count: number
  blocked_until: string | null
}

export async function checkAuthFailureBlock(
  request: Request,
  env: Env,
): Promise<{ principalHash: string | null; retryAfter: number | null }> {
  const principalHash = await getPrincipalHash(request, env)
  if (!principalHash) return { principalHash: null, retryAfter: null }

  try {
    const row = await env.DB.prepare(
      `SELECT window_started_at, failure_count, blocked_until
       FROM auth_failure_buckets WHERE principal_hash = ?`
    ).bind(principalHash).first<FailureBucket>()
    if (!row?.blocked_until) return { principalHash, retryAfter: null }

    const remaining = Date.parse(row.blocked_until) - Date.now()
    return {
      principalHash,
      retryAfter: remaining > 0 ? Math.max(1, Math.ceil(remaining / 1000)) : null,
    }
  } catch {
    // The migration may not be applied yet. Authentication still fails closed;
    // only the extra abuse throttle is temporarily unavailable.
    return { principalHash, retryAfter: null }
  }
}

export async function recordAuthFailure(
  env: Env,
  principalHash: string | null,
): Promise<void> {
  if (!principalHash) return
  const now = new Date()
  const limit = Math.max(1, readNonNegativeInt(
    env.AUTH_FAILURE_LIMIT_PER_HOUR,
    DEFAULT_FAILURE_LIMIT,
  ))
  const blockMinutes = Math.max(1, readNonNegativeInt(
    env.AUTH_FAILURE_BLOCK_MINUTES,
    DEFAULT_BLOCK_MINUTES,
  ))

  try {
    const row = await env.DB.prepare(
      `SELECT window_started_at, failure_count, blocked_until
       FROM auth_failure_buckets WHERE principal_hash = ?`
    ).bind(principalHash).first<FailureBucket>()

    const windowExpired = !row || Date.parse(row.window_started_at) <= now.getTime() - WINDOW_MS
    const nextCount = windowExpired ? 1 : row.failure_count + 1
    const blockedUntil = nextCount >= limit
      ? new Date(now.getTime() + blockMinutes * 60 * 1000).toISOString()
      : (row?.blocked_until ?? null)
    const windowStartedAt = windowExpired ? now.toISOString() : row.window_started_at

    await env.DB.prepare(
      `INSERT INTO auth_failure_buckets (
        principal_hash, window_started_at, failure_count, blocked_until, last_seen_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(principal_hash) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        failure_count = excluded.failure_count,
        blocked_until = excluded.blocked_until,
        last_seen_at = excluded.last_seen_at`
    ).bind(
      principalHash,
      windowStartedAt,
      nextCount,
      blockedUntil,
      now.toISOString(),
    ).run()
  } catch (error) {
    console.warn('[auth-abuse] failure not recorded:', error instanceof Error ? error.message : String(error))
  }
}

async function getPrincipalHash(request: Request, env: Env): Promise<string | null> {
  const ip = getClientIp(request)
  if (!ip || !env.ABUSE_HASH_SECRET) return null
  return hmacIdentifier(`auth-ip:${ip}`, env.ABUSE_HASH_SECRET)
}
