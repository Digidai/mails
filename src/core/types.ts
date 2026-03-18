export interface SendAttachment {
  filename?: string
  content?: string | ArrayBuffer | Uint8Array
  path?: string
  contentType?: string
  contentId?: string
}

export interface PreparedAttachment {
  filename: string
  content: string
  contentType?: string
  contentId?: string
}

export type AttachmentTextExtractionStatus =
  | 'pending'
  | 'done'
  | 'unsupported'
  | 'failed'
  | 'too_large'

export interface Attachment {
  id: string
  email_id: string
  filename: string
  content_type: string
  size_bytes: number | null
  content_disposition: string | null
  content_id: string | null
  mime_part_index: number
  text_content: string
  text_extraction_status: AttachmentTextExtractionStatus
  storage_key: string | null
  content_base64?: string | null
  downloadable?: boolean
  created_at: string
}

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
  message_id?: string | null
  has_attachments?: boolean
  attachment_count?: number
  attachment_names?: string
  attachment_search_text?: string
  raw_storage_key?: string | null
  attachments?: Attachment[]
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
  headers?: Record<string, string>
  attachments?: SendAttachment[]
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
  attachment_blob_store?: string
  attachment_blob_path?: string
  api_key?: string
  resend_api_key?: string
  db9_token?: string
  db9_database_id?: string
  cloudflare_api_token?: string
  cloudflare_zone_id?: string
  worker_url?: string
  worker_api_key?: string
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
    headers?: Record<string, string>
    attachments?: PreparedAttachment[]
  }): Promise<SendResult>
}

export interface StorageProvider {
  name: string
  init(): Promise<void>
  saveEmail(email: Email): Promise<void>
  getEmails(mailbox: string, options?: {
    limit?: number
    offset?: number
    direction?: 'inbound' | 'outbound'
  }): Promise<Email[]>
  getEmail(id: string): Promise<Email | null>
  getAttachment(id: string): Promise<Attachment | null>
  getCode(mailbox: string, options?: {
    timeout?: number
    since?: string
  }): Promise<{ code: string; from: string; subject: string } | null>
}

export interface AttachmentBlobStore {
  name: string
  put(key: string, content: Uint8Array, options?: {
    contentType?: string
    metadata?: Record<string, string>
  }): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}
