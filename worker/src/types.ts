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
  SEND_ABUSE_GUARD_ENABLED?: string
  DAILY_CLAIM_LIMIT?: string
}

export interface AuthContext {
  mailbox: string | null
  /** 'full' = all operations, 'mailbox' = restricted to own mailbox */
  scope: 'full' | 'mailbox'
}
