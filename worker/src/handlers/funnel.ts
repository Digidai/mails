import type { Env } from '../types'

type FunnelMetadata = {
  source?: string
  clientName?: string
  clientVersion?: string | null
  flow?: string
  outcome?: 'success' | 'failure'
  errorCode?: string | null
}

export async function recordFunnelEvent(
  env: Env,
  eventName: string,
  anonymousId: string,
  metadata: FunnelMetadata = {},
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO funnel_events (
        id, event_name, anonymous_id, source, client_name, client_version,
        flow, outcome, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      eventName.slice(0, 64),
      anonymousId.slice(0, 128),
      (metadata.source ?? 'unknown').slice(0, 64),
      (metadata.clientName ?? 'unknown').slice(0, 64),
      metadata.clientVersion?.slice(0, 32) ?? null,
      (metadata.flow ?? 'api').slice(0, 64),
      metadata.outcome ?? 'success',
      metadata.errorCode?.slice(0, 64) ?? null,
      new Date().toISOString(),
    ).run()
  } catch (error) {
    console.warn(
      '[funnel] event not recorded:',
      eventName,
      error instanceof Error ? error.message : String(error),
    )
  }
}
