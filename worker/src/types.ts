export interface Env {
  DB: D1Database
  ATTACHMENTS?: R2Bucket
  AI?: Ai
  VECTORIZE?: VectorizeIndex
  MAILS_GTM_WORKER?: Fetcher  // Service binding to mails-gtm-agent
  MAILS_GTM_WORKER_HOSTS?: string
  AUTH_TOKEN?: string
  AUTH_TOKENS?: string
  ALLOW_PUBLIC_API?: string
  RESEND_API_KEY?: string
  WEBHOOK_SECRET?: string
  RESEND_WEBHOOK_SECRET?: string
  DAILY_SEND_LIMIT?: string
  GLOBAL_DAILY_SEND_LIMIT?: string
  NEW_MAILBOX_SEND_LIMIT?: string
  NEW_MAILBOX_SEND_WINDOW_HOURS?: string
  RATE_LIMIT_FAIL_OPEN?: string
  SEND_ABUSE_GUARD_ENABLED?: string
  SEND_WARMUP_ENABLED?: string
  /** Hours a brand-new mailbox must wait before /api/send is allowed. Default 24. Set "0" to disable. */
  SEND_WARMUP_HOURS?: string
  DAILY_CLAIM_LIMIT?: string
  /** Cloudflare Turnstile secret key. When set, /v1/claim/confirm requires a valid token. */
  TURNSTILE_SECRET?: string
}

export interface AuthContext {
  mailbox: string | null
  /** 'full' = all operations, 'mailbox' = restricted to own mailbox */
  scope: 'full' | 'mailbox'
}
