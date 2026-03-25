export interface Env {
  DB: D1Database
  ATTACHMENTS?: R2Bucket
  AUTH_TOKEN?: string
  AUTH_TOKENS?: string
  RESEND_API_KEY?: string
  WEBHOOK_SECRET?: string
}

export interface AuthContext {
  mailbox: string | null
}
