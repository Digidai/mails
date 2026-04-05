export interface Env {
  DB: D1Database
  ATTACHMENTS?: R2Bucket
  AI?: Ai
  VECTORIZE?: VectorizeIndex
  MAILS_GTM_WORKER?: Fetcher  // Service binding to mails-gtm-agent
  AUTH_TOKEN?: string
  AUTH_TOKENS?: string
  RESEND_API_KEY?: string
  WEBHOOK_SECRET?: string
  RESEND_WEBHOOK_SECRET?: string
  DAILY_SEND_LIMIT?: string
}

export interface AuthContext {
  mailbox: string | null
  /** 'full' = all operations, 'mailbox' = restricted to own mailbox */
  scope: 'full' | 'mailbox'
}
