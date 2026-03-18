export interface Email {
  id: string
  mailbox: string
  from_address: string
  from_name: string
  to_address: string
  subject: string
  body_text: string
  body_html: string
  code: string | null
  headers: Record<string, string>
  metadata: Record<string, unknown>
  direction: 'inbound' | 'outbound'
  status: 'received' | 'sent' | 'failed' | 'queued'
  received_at: string
  created_at: string
}

export interface SendOptions {
  from?: string
  to: string | string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string
}

export interface SendResult {
  id: string
  provider: string
}

export interface MailsConfig {
  mode: 'hosted' | 'selfhosted'
  domain: string
  mailbox: string
  send_provider: string
  storage_provider: string
  resend_api_key?: string
  db9_token?: string
  db9_database_id?: string
  cloudflare_api_token?: string
  cloudflare_zone_id?: string
  worker_url?: string
  default_from?: string
}

export interface SendProvider {
  name: string
  send(options: {
    from: string
    to: string[]
    subject: string
    text?: string
    html?: string
    replyTo?: string
  }): Promise<SendResult>
}

export interface EmailQueryOptions {
  limit?: number
  offset?: number
  direction?: 'inbound' | 'outbound'
}

export interface EmailSearchOptions extends EmailQueryOptions {
  query: string
}

export interface StorageProvider {
  name: string
  init(): Promise<void>
  saveEmail(email: Email): Promise<void>
  getEmails(mailbox: string, options?: EmailQueryOptions): Promise<Email[]>
  searchEmails(mailbox: string, options: EmailSearchOptions): Promise<Email[]>
  getEmail(id: string): Promise<Email | null>
  getCode(mailbox: string, options?: {
    timeout?: number
    since?: string
  }): Promise<{ code: string; from: string; subject: string } | null>
}
