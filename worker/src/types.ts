export interface Env {
  DB: D1Database
  ATTACHMENTS?: R2Bucket
  AI?: Ai
  VECTORIZE?: VectorizeIndex
  AUTH_TOKEN?: string
  AUTH_TOKENS?: string
  RESEND_API_KEY?: string
  WEBHOOK_SECRET?: string
  RESEND_WEBHOOK_SECRET?: string
}

export interface AuthContext {
  mailbox: string | null
  /** 'full' = all operations, 'mailbox' = restricted to own mailbox */
  scope: 'full' | 'mailbox'
}
