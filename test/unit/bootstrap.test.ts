import { describe, expect, test } from 'bun:test'
import { handleBootstrap } from '../../worker/src/handlers/bootstrap'

type Row = Record<string, unknown>

function request(idempotencyKey = 'bootstrap-test-key-0001') {
  return new Request('https://api.mails0.com/v1/bootstrap', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '203.0.113.10',
      'Idempotency-Key': idempotencyKey,
      'X-Mails-Client': 'test-client',
      'X-Mails-Client-Version': '1.0.0',
      'X-Mails-Source': 'test',
    },
    body: '{}',
  })
}

function mockDB(options: {
  replay?: Row | null
  principalQuotaAllowed?: boolean
  globalQuotaAllowed?: boolean
} = {}) {
  const statements: Array<{ sql: string; args: unknown[] }> = []
  const batches: Array<Array<{ sql: string; args: unknown[] }>> = []
  const prepare = (sql: string) => {
    const statement = {
      sql,
      args: [] as unknown[],
      bind(...args: unknown[]) {
        statement.args = args
        return statement
      },
      async first() {
        if (sql.includes('FROM bootstrap_grants g')) return options.replay ?? null
        return null
      },
      async run() {
        statements.push({ sql, args: statement.args })
        if (sql.includes('UPDATE bootstrap_quota_buckets')) {
          const bucketKey = String(statement.args[1] ?? '')
          const allowed = bucketKey.startsWith('principal:')
            ? options.principalQuotaAllowed !== false
            : options.globalQuotaAllowed !== false
          return { meta: { changes: allowed ? 1 : 0 } }
        }
        return { meta: { changes: 1 } }
      },
    }
    return statement
  }
  return {
    statements,
    batches,
    prepare,
    async batch(items: Array<{ sql: string; args: unknown[] }>) {
      batches.push(items.map((item) => ({ sql: item.sql, args: item.args })))
      return items.map(() => ({ meta: { changes: 1 } }))
    },
  }
}

function env(db = mockDB()) {
  return {
    DB: db,
    BOOTSTRAP_ENABLED: 'true',
    ABUSE_HASH_SECRET: 'test-hmac-secret',
    PROVISIONAL_TTL_HOURS: '72',
  } as any
}

describe('POST /v1/bootstrap', () => {
  test('is disabled unless explicitly enabled', async () => {
    const response = await handleBootstrap(request(), { DB: mockDB() } as any)
    expect(response.status).toBe(404)
  })

  test('fails closed when the HMAC secret is missing', async () => {
    const response = await handleBootstrap(request(), {
      DB: mockDB(),
      BOOTSTRAP_ENABLED: 'true',
    } as any)
    expect(response.status).toBe(503)
  })

  test('rejects bootstrap calls embedded by third-party websites', async () => {
    const thirdPartyRequest = request()
    thirdPartyRequest.headers.set('Origin', 'https://malicious.example')
    const response = await handleBootstrap(thirdPartyRequest, env())
    expect(response.status).toBe(403)
  })

  test('allows the first-party website origin', async () => {
    const firstPartyRequest = request()
    firstPartyRequest.headers.set('Origin', 'https://mails0.com')
    const response = await handleBootstrap(firstPartyRequest, env())
    expect(response.status).toBe(201)
  })

  test('requires a high-entropy idempotency key', async () => {
    const response = await handleBootstrap(request('short'), env())
    expect(response.status).toBe(400)
  })

  test('creates an expiring receive-only token and never grants operator scope', async () => {
    const db = mockDB()
    const before = Date.now()
    const response = await handleBootstrap(request(), env(db))
    expect(response.status).toBe(201)
    const data = await response.json() as {
      mailbox: string
      api_key: string
      scope: string
      expires_at: string
      capabilities: string[]
    }
    expect(data.mailbox).toMatch(/^agent-[a-f0-9]{12}@mails0\.com$/)
    expect(data.api_key).toMatch(/^mk_[a-f0-9]{64}$/)
    expect(data.scope).toBe('provisional')
    expect(data.capabilities).not.toContain('email.send')
    expect(Date.parse(data.expires_at)).toBeGreaterThan(before + 71 * 60 * 60 * 1000)

    const tokenInsert = db.batches[0].find((entry) => entry.sql.includes('INSERT INTO auth_tokens'))
    expect(tokenInsert?.sql).toContain("'provisional'")
    expect(tokenInsert?.sql).not.toContain("'operator'")
  })

  test('replays the same grant for the same idempotency key', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const db = mockDB({
      replay: {
        mailbox: 'agent-existing@mails0.com',
        token: 'mk_existing',
        expires_at: expiresAt,
      },
    })
    const response = await handleBootstrap(request(), env(db))
    const data = await response.json() as { api_key: string; replayed: boolean }
    expect(response.status).toBe(200)
    expect(data.api_key).toBe('mk_existing')
    expect(data.replayed).toBe(true)
    expect(db.batches).toHaveLength(0)
  })

  test('reuses an idempotency key safely after its previous grant expired', async () => {
    const db = mockDB({
      replay: {
        mailbox: 'agent-expired@mails0.com',
        token: 'mk_expired',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    const response = await handleBootstrap(request(), env(db))
    expect(response.status).toBe(201)
    expect(db.statements.some((entry) => entry.sql.includes('DELETE FROM bootstrap_grants'))).toBe(true)
    expect(db.batches).toHaveLength(1)
  })

  test('enforces the atomic daily principal quota', async () => {
    const response = await handleBootstrap(request(), env(mockDB({ principalQuotaAllowed: false })))
    expect(response.status).toBe(429)
    const data = await response.json() as { code: string }
    expect(data.code).toBe('provisional_daily_limit')
  })

  test('enforces the atomic global daily quota', async () => {
    const response = await handleBootstrap(request(), env(mockDB({ globalQuotaAllowed: false })))
    expect(response.status).toBe(429)
    const data = await response.json() as { code: string }
    expect(data.code).toBe('global_bootstrap_limit')
  })
})
