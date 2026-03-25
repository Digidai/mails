import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Email, EmailQueryOptions, EmailSearchOptions, StorageProvider } from '../../core/types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT DEFAULT '',
  to_address TEXT NOT NULL,
  subject TEXT DEFAULT '',
  body_text TEXT DEFAULT '',
  body_html TEXT DEFAULT '',
  code TEXT,
  headers TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  message_id TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  raw_storage_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  content_disposition TEXT,
  content_id TEXT,
  mime_part_index INTEGER NOT NULL,
  text_content TEXT DEFAULT '',
  text_extraction_status TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
`

export function createSqliteProvider(dbPath?: string): StorageProvider {
  const dir = join(homedir(), '.mails')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const path = dbPath ?? join(dir, 'mails.db')
  let db: Database

  return {
    name: 'sqlite',

    async init() {
      db = new Database(path)
      db.exec('PRAGMA journal_mode=WAL;')
      db.exec(SCHEMA)
    },

    async close() {
      db.close()
    },

    async saveEmail(email: Email) {
      const attachments = email.attachments ?? []
      const attachmentCount = email.attachment_count ?? attachments.length
      const attachmentNames = email.attachment_names
        ?? attachments.map((attachment) => attachment.filename).join(', ')

      db.prepare(`
        INSERT OR REPLACE INTO emails (
          id, mailbox, from_address, from_name, to_address, subject,
          body_text, body_html, code, headers, metadata,
          message_id, has_attachments, attachment_count, attachment_names, attachment_search_text, raw_storage_key,
          direction, status, received_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        email.id, email.mailbox, email.from_address, email.from_name,
        email.to_address, email.subject, email.body_text, email.body_html,
        email.code, JSON.stringify(email.headers), JSON.stringify(email.metadata),
        email.message_id ?? null, (email.has_attachments ?? attachmentCount > 0) ? 1 : 0, attachmentCount,
        attachmentNames, email.attachment_search_text ?? '', email.raw_storage_key ?? null,
        email.direction, email.status, email.received_at, email.created_at,
      )

      db.prepare('DELETE FROM attachments WHERE email_id = ?').run(email.id)

      for (const attachment of attachments) {
        db.prepare(`
          INSERT OR REPLACE INTO attachments (
            id, email_id, filename, content_type, size_bytes,
            content_disposition, content_id, mime_part_index,
            text_content, text_extraction_status, storage_key, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attachment.id,
          attachment.email_id,
          attachment.filename,
          attachment.content_type,
          attachment.size_bytes ?? null,
          attachment.content_disposition ?? null,
          attachment.content_id ?? null,
          attachment.mime_part_index,
          attachment.text_content,
          attachment.text_extraction_status,
          attachment.storage_key ?? null,
          attachment.created_at,
        )
      }
    },

    async getEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      let query = 'SELECT * FROM emails WHERE mailbox = ?'
      const params: (string | number)[] = [mailbox]

      if (options?.direction) {
        query += ' AND direction = ?'
        params.push(options.direction)
      }

      query += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
      params.push(limit, offset)

      const rows = db.prepare(query).all(...params) as Record<string, unknown>[]
      return rows.map((row) => rowToEmail(row))
    },

    async searchEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      const pattern = `%${options.query}%`
      let query = `
        SELECT * FROM emails
        WHERE mailbox = ?
      `
      const params: (string | number)[] = [mailbox]

      if (options.direction) {
        query += ' AND direction = ?'
        params.push(options.direction)
      }

      query += `
        AND (
          subject LIKE ? COLLATE NOCASE
          OR body_text LIKE ? COLLATE NOCASE
          OR from_address LIKE ? COLLATE NOCASE
          OR from_name LIKE ? COLLATE NOCASE
          OR to_address LIKE ? COLLATE NOCASE
          OR code LIKE ? COLLATE NOCASE
        )
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?
      `

      params.push(pattern, pattern, pattern, pattern, pattern, pattern, limit, offset)

      const rows = db.prepare(query).all(...params) as Record<string, unknown>[]
      return rows.map((row) => rowToEmail(row))
    },

    async getEmail(id) {
      const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Record<string, unknown> | null
      if (!row) return null

      const attachmentRows = db.prepare(`
        SELECT * FROM attachments
        WHERE email_id = ?
        ORDER BY mime_part_index ASC
      `).all(id) as Record<string, unknown>[]

      return rowToEmail(row, attachmentRows.map(rowToAttachment))
    },

    async deleteEmail(id) {
      db.prepare('DELETE FROM attachments WHERE email_id = ?').run(id)
      const result = db.prepare('DELETE FROM emails WHERE id = ?').run(id)
      return result.changes > 0
    },

    async getCode(mailbox, options) {
      const timeout = (options?.timeout ?? 30) * 1000
      const since = options?.since
      const deadline = Date.now() + timeout

      while (Date.now() < deadline) {
        let query = 'SELECT code, from_address, subject FROM emails WHERE mailbox = ? AND code IS NOT NULL'
        const params: string[] = [mailbox]

        if (since) {
          query += ' AND received_at > ?'
          params.push(since)
        }

        query += ' ORDER BY received_at DESC LIMIT 1'

        const row = db.prepare(query).get(...params) as { code: string; from_address: string; subject: string } | null
        if (row) {
          return { code: row.code, from: row.from_address, subject: row.subject }
        }

        await new Promise(r => setTimeout(r, 1000))
      }

      return null
    },
  }
}

function rowToEmail(row: Record<string, unknown>, attachments?: Email['attachments']): Email {
  return {
    id: row.id as string,
    mailbox: row.mailbox as string,
    from_address: row.from_address as string,
    from_name: (row.from_name as string) ?? '',
    to_address: row.to_address as string,
    subject: (row.subject as string) ?? '',
    body_text: (row.body_text as string) ?? '',
    body_html: (row.body_html as string) ?? '',
    code: (row.code as string) ?? null,
    headers: safeJsonParse(row.headers as string, {}),
    metadata: safeJsonParse(row.metadata as string, {}),
    message_id: (row.message_id as string) ?? null,
    has_attachments: Boolean(row.has_attachments),
    attachment_count: (row.attachment_count as number) ?? 0,
    attachment_names: (row.attachment_names as string) ?? '',
    attachment_search_text: (row.attachment_search_text as string) ?? '',
    raw_storage_key: (row.raw_storage_key as string) ?? null,
    attachments,
    direction: row.direction as Email['direction'],
    status: row.status as Email['status'],
    received_at: row.received_at as string,
    created_at: row.created_at as string,
  }
}

function rowToAttachment(row: Record<string, unknown>): NonNullable<Email['attachments']>[number] {
  return {
    id: row.id as string,
    email_id: row.email_id as string,
    filename: row.filename as string,
    content_type: row.content_type as string,
    size_bytes: (row.size_bytes as number | null) ?? null,
    content_disposition: (row.content_disposition as string | null) ?? null,
    content_id: (row.content_id as string | null) ?? null,
    mime_part_index: row.mime_part_index as number,
    text_content: (row.text_content as string) ?? '',
    text_extraction_status: row.text_extraction_status as NonNullable<Email['attachments']>[number]['text_extraction_status'],
    storage_key: (row.storage_key as string | null) ?? null,
    downloadable: Boolean((row.storage_key as string | null) || row.text_content),
    created_at: row.created_at as string,
  }
}

function safeJsonParse<T>(str: string | undefined, fallback: T): T {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

function normalizeQueryOptions(options?: EmailQueryOptions | EmailSearchOptions): { limit: number; offset: number } {
  const limit = Number.isFinite(options?.limit) ? Math.trunc(options!.limit!) : 20
  const offset = Number.isFinite(options?.offset) ? Math.trunc(options!.offset!) : 0

  return {
    limit: limit > 0 ? limit : 20,
    offset: offset >= 0 ? offset : 0,
  }
}
