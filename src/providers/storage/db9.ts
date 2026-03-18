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
  headers JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_search_fts
ON emails
USING GIN (
  setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(from_name, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(body_text, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(body_html, '')), 'D')
);
`

const SEARCH_VECTOR = `
  setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(from_name, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(body_text, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(body_html, '')), 'D')
`

interface Db9SqlResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
}

export function createDb9Provider(token: string, databaseId: string): StorageProvider {
  const baseUrl = 'https://api.db9.ai'
  const esc = (s: string) => s.replace(/'/g, "''")

  async function sql(query: string): Promise<Db9SqlResult> {
    const res = await fetch(`${baseUrl}/customer/databases/${databaseId}/sql`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`db9 error (${res.status}): ${text}`)
    }
    return await res.json() as Db9SqlResult
  }

  function rowsToEmails(result: Db9SqlResult): Email[] {
    return result.rows.map(row => {
      const obj: Record<string, unknown> = {}
      result.columns.forEach((col, i) => { obj[col] = row[i] })
      return {
        id: obj.id as string,
        mailbox: obj.mailbox as string,
        from_address: obj.from_address as string,
        from_name: (obj.from_name as string) ?? '',
        to_address: obj.to_address as string,
        subject: (obj.subject as string) ?? '',
        body_text: (obj.body_text as string) ?? '',
        body_html: (obj.body_html as string) ?? '',
        code: (obj.code as string) ?? null,
        headers: typeof obj.headers === 'string' ? JSON.parse(obj.headers) : (obj.headers as Record<string, string>) ?? {},
        metadata: typeof obj.metadata === 'string' ? JSON.parse(obj.metadata) : (obj.metadata as Record<string, unknown>) ?? {},
        direction: obj.direction as Email['direction'],
        status: obj.status as Email['status'],
        received_at: obj.received_at as string,
        created_at: obj.created_at as string,
      }
    })
  }

  return {
    name: 'db9',

    async init() {
      await sql(SCHEMA)
    },

    async saveEmail(email: Email) {
      await sql(`
        INSERT INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, headers, metadata, direction, status, received_at, created_at)
        VALUES (
          '${esc(email.id)}', '${esc(email.mailbox)}', '${esc(email.from_address)}', '${esc(email.from_name)}',
          '${esc(email.to_address)}', '${esc(email.subject)}', '${esc(email.body_text)}', '${esc(email.body_html)}',
          ${email.code ? `'${esc(email.code)}'` : 'NULL'},
          '${esc(JSON.stringify(email.headers))}'::jsonb,
          '${esc(JSON.stringify(email.metadata))}'::jsonb,
          '${esc(email.direction)}', '${esc(email.status)}',
          '${esc(email.received_at)}', '${esc(email.created_at)}'
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata
      `)
    },

    async getEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      let query = `SELECT * FROM emails WHERE mailbox = '${esc(mailbox)}'`

      if (options?.direction) {
        query += ` AND direction = '${esc(options.direction)}'`
      }

      query += ` ORDER BY received_at DESC LIMIT ${limit} OFFSET ${offset}`

      const result = await sql(query)
      return rowsToEmails(result)
    },

    async searchEmails(mailbox, options) {
      const { limit, offset } = normalizeQueryOptions(options)
      const directionClause = options.direction
        ? `AND direction = '${esc(options.direction)}'`
        : ''
      const query = esc(options.query)
      const pattern = `%${query}%`

      const result = await sql(`
        WITH ranked AS (
          SELECT
            *,
            ts_rank(
              ${SEARCH_VECTOR},
              websearch_to_tsquery('simple', '${query}')
            ) AS rank
          FROM emails
          WHERE mailbox = '${esc(mailbox)}'
            ${directionClause}
            AND (
              (${SEARCH_VECTOR}) @@ websearch_to_tsquery('simple', '${query}')
              OR from_address ILIKE '${pattern}'
              OR to_address ILIKE '${pattern}'
              OR code ILIKE '${pattern}'
            )
        )
        SELECT *
        FROM ranked
        ORDER BY rank DESC, received_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `)

      return rowsToEmails(result)
    },

    async getEmail(id) {
      const result = await sql(`SELECT * FROM emails WHERE id = '${esc(id)}' LIMIT 1`)
      const emails = rowsToEmails(result)
      return emails[0] ?? null
    },

    async getCode(mailbox, options) {
      const timeout = (options?.timeout ?? 30) * 1000
      const since = options?.since
      const deadline = Date.now() + timeout

      while (Date.now() < deadline) {
        let query = `SELECT code, from_address, subject FROM emails WHERE mailbox = '${esc(mailbox)}' AND code IS NOT NULL`

        if (since) {
          query += ` AND received_at > '${esc(since)}'`
        }

        query += ' ORDER BY received_at DESC LIMIT 1'

        const result = await sql(query)
        if (result.row_count > 0) {
          const row = result.rows[0]!
          const codeIdx = result.columns.indexOf('code')
          const fromIdx = result.columns.indexOf('from_address')
          const subIdx = result.columns.indexOf('subject')
          return {
            code: row[codeIdx] as string,
            from: row[fromIdx] as string,
            subject: row[subIdx] as string,
          }
        }

        await new Promise(r => setTimeout(r, 2000))
      }

      return null
    },
  }
}

function normalizeQueryOptions(options?: EmailQueryOptions | EmailSearchOptions): { limit: number; offset: number } {
  const limit = Number.isFinite(options?.limit) ? Math.trunc(options!.limit!) : 20
  const offset = Number.isFinite(options?.offset) ? Math.trunc(options!.offset!) : 0

  return {
    limit: limit > 0 ? limit : 20,
    offset: offset >= 0 ? offset : 0,
  }
}
