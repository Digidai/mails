import { describe, expect, test } from 'bun:test'
import { handleHealth } from '../../worker/src/index'
import type { Env } from '../../worker/src/types'

function healthEnv(failingQuery?: string): Env {
  return {
    DB: {
      prepare(query: string) {
        return {
          async first() {
            if (failingQuery && query.includes(failingQuery)) {
              throw new Error('schema missing')
            }
            return query.includes('SELECT 1 AS ok') ? { ok: 1 } : null
          },
        }
      },
    },
    ATTACHMENTS: {},
    AI: {},
    VECTORIZE: {},
    BOOTSTRAP_ENABLED: 'true',
    ABUSE_HASH_SECRET: 'test-secret',
  } as unknown as Env
}

describe('Worker readiness health check', () => {
  test('passes only when production bindings and schemas are ready', async () => {
    const response = await handleHealth(healthEnv())
    const body = await response.json() as {
      ok: boolean
      checks: Record<string, boolean>
    }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.checks).toMatchObject({
      db: true,
      auth_schema: true,
      bootstrap_schema: true,
      funnel_schema: true,
      growth_schema: true,
      bootstrap_config: true,
    })
  })

  test('fails closed when a required schema is missing', async () => {
    const response = await handleHealth(healthEnv('bootstrap_grants'))
    const body = await response.json() as {
      ok: boolean
      checks: Record<string, boolean>
    }

    expect(response.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.checks.bootstrap_schema).toBe(false)
  })

  test('fails closed when bootstrap abuse protection is not configured', async () => {
    const env = healthEnv()
    env.ABUSE_HASH_SECRET = undefined

    const response = await handleHealth(env)
    const body = await response.json() as { ok: boolean }

    expect(response.status).toBe(503)
    expect(body.ok).toBe(false)
  })
})
