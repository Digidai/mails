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
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
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

    async saveEmail(email: Email) {
      db.prepare(`
        INSERT OR REPLACE INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, headers, metadata, direction, status, received_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        email.id, email.mailbox, email.from_address, email.from_name,
        email.to_address, email.subject, email.body_text, email.body_html,
        email.code, JSON.stringify(email.headers), JSON.stringify(email.metadata),
        email.direction, email.status, email.received_at, email.created_at,
      )
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

      const rows = db.prepare(query).all(...params) as Record<string, string>[]
      return rows.map(rowToEmail)
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
          OR body_html LIKE ? COLLATE NOCASE
          OR from_address LIKE ? COLLATE NOCASE
          OR from_name LIKE ? COLLATE NOCASE
          OR to_address LIKE ? COLLATE NOCASE
          OR code LIKE ? COLLATE NOCASE
        )
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?
      `

      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit, offset)

      const rows = db.prepare(query).all(...params) as Record<string, string>[]
      return rows.map(rowToEmail)
    },

    async getEmail(id) {
      const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Record<string, string> | null
      return row ? rowToEmail(row) : null
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

function rowToEmail(row: Record<string, string>): Email {
  return {
    id: row.id!,
    mailbox: row.mailbox!,
    from_address: row.from_address!,
    from_name: row.from_name ?? '',
    to_address: row.to_address!,
    subject: row.subject ?? '',
    body_text: row.body_text ?? '',
    body_html: row.body_html ?? '',
    code: row.code ?? null,
    headers: safeJsonParse(row.headers, {}),
    metadata: safeJsonParse(row.metadata, {}),
    direction: row.direction as Email['direction'],
    status: row.status as Email['status'],
    received_at: row.received_at!,
    created_at: row.created_at!,
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
