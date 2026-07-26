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
  /** Explicitly enables the anonymous, receive-only provisional mailbox flow. */
  BOOTSTRAP_ENABLED?: string
  /** Comma-separated browser origins allowed to call bootstrap. Origin-less CLI/MCP requests are allowed. */
  BOOTSTRAP_ALLOWED_ORIGINS?: string
  /** Secret used to HMAC network identifiers and API tokens before analytics/rate-limit storage. */
  ABUSE_HASH_SECRET?: string
  /** Lifetime of provisional mailboxes. Default 72 hours. */
  PROVISIONAL_TTL_HOURS?: string
  BOOTSTRAP_IP_DAILY_LIMIT?: string
  BOOTSTRAP_GLOBAL_DAILY_LIMIT?: string
  AUTH_FAILURE_LIMIT_PER_HOUR?: string
  AUTH_FAILURE_BLOCK_MINUTES?: string
  /** Cloudflare Turnstile secret key. When set, /v1/claim/confirm requires a valid token. */
  TURNSTILE_SECRET?: string
  /** Domain that claimed mailboxes are created under (e.g. "mail.openjobs-ai.com"). Defaults to "mails0.com". */
  MAILBOX_DOMAIN?: string
}

export interface AuthContext {
  mailbox: string | null
  /** Operators may provision/moderate; mailbox tokens are tenant-scoped; provisional tokens are receive-only and expire. */
  scope: 'operator' | 'mailbox' | 'provisional'
  expiresAt: string | null
  subjectId: string
}
