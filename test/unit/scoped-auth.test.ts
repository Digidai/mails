import { describe, test, expect } from 'bun:test'

describe('Scoped Auth', () => {
  test('AuthContext interface includes scope field', async () => {
    // Import the type and verify the auth handler returns scope
    const { resolveAuth, _resetAuthCache } = await import('../../worker/src/handlers/auth')
    _resetAuthCache()

    // Mock env with D1 auth_tokens table returning scoped key
    const env = {
      DB: {
        prepare: (sql: string) => ({
          run: async () => {
            if (sql.includes('SELECT 1 FROM auth_tokens')) return {}
            return {}
          },
          bind: (...args: unknown[]) => ({
            first: async () => {
              if (sql.includes('SELECT mailbox')) {
                return { mailbox: 'agent@mails0.com', scope: 'mailbox' }
              }
              return null
            },
            run: async () => ({}),
          }),
        }),
      },
    } as any

    const request = new Request('http://localhost/v1/inbox', {
      headers: { 'Authorization': 'Bearer test-token' },
    })

    const auth = await resolveAuth(request, env, true)
    expect(auth).not.toBeNull()
    expect(auth!.mailbox).toBe('agent@mails0.com')
    expect(auth!.scope).toBe('mailbox')
  })

  test('resolveAuth treats legacy non-scoped keys as mailbox-only', async () => {
    const { resolveAuth, _resetAuthCache } = await import('../../worker/src/handlers/auth')
    _resetAuthCache()

    const env = {
      DB: {
        prepare: (sql: string) => ({
          run: async () => ({}),
          bind: (...args: unknown[]) => ({
            first: async () => {
              if (sql.includes('SELECT mailbox')) {
                return { mailbox: 'admin@mails0.com', scope: null }
              }
              return null
            },
            run: async () => ({}),
          }),
        }),
      },
    } as any

    const request = new Request('http://localhost/v1/inbox', {
      headers: { 'Authorization': 'Bearer admin-token' },
    })

    const auth = await resolveAuth(request, env, true)
    expect(auth).not.toBeNull()
    expect(auth!.scope).toBe('mailbox')
  })

  test('resolveAuth grants operator rights only for an explicit operator scope', async () => {
    const { resolveAuth, _resetAuthCache } = await import('../../worker/src/handlers/auth')
    _resetAuthCache()
    const env = {
      ABUSE_HASH_SECRET: 'test-secret',
      DB: {
        prepare: (sql: string) => ({
          run: async () => ({}),
          bind: () => ({
            first: async () => sql.includes('SELECT mailbox')
              ? { mailbox: 'ops@mails0.com', scope: 'operator', expires_at: null }
              : null,
            run: async () => ({}),
          }),
        }),
      },
    } as any
    const auth = await resolveAuth(new Request('http://localhost/v1/me', {
      headers: { Authorization: 'Bearer operator-token' },
    }), env, true)
    expect(auth?.scope).toBe('operator')
  })

  test('resolveAuth rejects an expired token', async () => {
    const { resolveAuth, _resetAuthCache } = await import('../../worker/src/handlers/auth')
    _resetAuthCache()
    const env = {
      DB: {
        prepare: (sql: string) => ({
          run: async () => ({}),
          bind: () => ({
            first: async () => sql.includes('SELECT mailbox')
              ? {
                  mailbox: 'expired@mails0.com',
                  scope: 'provisional',
                  expires_at: new Date(Date.now() - 60_000).toISOString(),
                }
              : null,
            run: async () => ({}),
          }),
        }),
      },
    } as any
    const auth = await resolveAuth(new Request('http://localhost/v1/me', {
      headers: { Authorization: 'Bearer expired-token' },
    }), env, true)
    expect(auth).toBeNull()
  })

  test('resolveAuth returns null for missing token', async () => {
    const { resolveAuth, _resetAuthCache } = await import('../../worker/src/handlers/auth')
    _resetAuthCache()

    const env = {
      DB: {
        prepare: () => ({
          run: async () => ({}),
          bind: () => ({ first: async () => null, run: async () => ({}) }),
        }),
      },
    } as any

    const request = new Request('http://localhost/v1/inbox')
    const auth = await resolveAuth(request, env, true)
    expect(auth).toBeNull()
  })
})
