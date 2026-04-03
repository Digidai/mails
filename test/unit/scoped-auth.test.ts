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

  test('resolveAuth returns full scope for non-scoped keys', async () => {
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
    expect(auth!.scope).toBe('full')
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
