import type { Email, EmailThread, EmailQueryOptions, EmailSearchOptions, ThreadQueryOptions, StorageProvider } from '../../core/types.js'

interface RemoteProviderOptions {
  /** Worker API base URL */
  url: string
  /** Mailbox address for query scoping */
  mailbox: string
  /** API key (for hosted /v1/* endpoints). If set, uses /v1/* paths. */
  apiKey?: string
  /** Auth token (api_key or worker_token). Sent as Bearer header. */
  token?: string
}

export function createRemoteProvider(options: RemoteProviderOptions): StorageProvider {
  const { url, mailbox, apiKey, token } = options
  const useAuthApi = !!apiKey

  async function apiFetch(path: string, params?: Record<string, string | number>): Promise<Response> {
    const endpoint = new URL(path, url)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) endpoint.searchParams.set(k, String(v))
      }
    }
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return fetch(endpoint.toString(), { headers })
  }

  // Authenticated endpoints (/v1/*) don't need ?to= — api_key is scoped to mailbox.
  // Public endpoints (/api/*) need ?to= to specify the mailbox.
  function inboxPath() { return useAuthApi ? '/v1/inbox' : '/api/inbox' }
  function codePath() { return useAuthApi ? '/v1/code' : '/api/code' }
  function emailPath() { return useAuthApi ? '/v1/email' : '/api/email' }
  function threadsPath() { return useAuthApi ? '/v1/threads' : '/api/threads' }
  function threadPath() { return useAuthApi ? '/v1/thread' : '/api/thread' }

  function withMailbox(params: Record<string, string | number>): Record<string, string | number> {
    if (!useAuthApi) {
      params.to = mailbox
    }
    return params
  }

  return {
    name: 'remote',

    async init() {},

    async close() {},

    async saveEmail() {
      throw new Error('Remote provider is read-only. Emails are received by the Worker.')
    },

    async getEmails(_mailbox, options) {
      const res = await apiFetch(inboxPath(), withMailbox({
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
        ...(options?.direction ? { direction: options.direction } : {}),
        ...(options?.label ? { label: options.label } : {}),
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { emails: Email[] }
      return data.emails
    },

    async searchEmails(_mailbox, options) {
      const res = await apiFetch(inboxPath(), withMailbox({
        query: options.query,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
        ...(options.direction ? { direction: options.direction } : {}),
        ...(options.label ? { label: options.label } : {}),
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { emails: Email[] }
      return data.emails
    },

    async getEmail(id) {
      const res = await apiFetch(emailPath(), { id })
      if (!res.ok) {
        if (res.status === 404) return null
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      return await res.json() as Email
    },

    async deleteEmail(id) {
      const endpoint = new URL(emailPath(), url)
      endpoint.searchParams.set('id', id)
      const headers: Record<string, string> = {}
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }
      const res = await fetch(endpoint.toString(), { method: 'DELETE', headers })
      if (res.status === 404) return false
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      return true
    },

    async getCode(_mailbox, options) {
      const res = await apiFetch(codePath(), withMailbox({
        timeout: options?.timeout ?? 30,
        ...(options?.since ? { since: options.since } : {}),
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { code: string | null; from?: string; subject?: string }
      if (!data.code) return null
      return { code: data.code, from: data.from ?? '', subject: data.subject ?? '' }
    },

    async getThreads(_mailbox, options) {
      const res = await apiFetch(threadsPath(), withMailbox({
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
      }))
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { threads: EmailThread[] }
      return data.threads
    },

    async getThread(threadId) {
      const res = await apiFetch(threadPath(), { id: threadId })
      if (!res.ok) {
        if (res.status === 404) return []
        const data = await res.json() as { error?: string }
        throw new Error(`API error: ${data.error ?? res.statusText}`)
      }
      const data = await res.json() as { emails: Email[] }
      return data.emails
    },
  }
}
