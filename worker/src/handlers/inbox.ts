import type { Env } from '../types'
import { semanticSearch } from '../embeddings'

export async function handleInbox(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const to = mailbox ?? url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })

  // Validate and clamp limit: must be positive integer, 1..100
  const rawLimit = url.searchParams.get('limit')
  let limit = 20
  if (rawLimit !== null) {
    const n = parseInt(rawLimit, 10)
    if (isNaN(n) || n < 1) {
      return Response.json(
        { error: 'limit must be a positive integer (1-100)' },
        { status: 400 }
      )
    }
    limit = Math.min(n, 100)
  }

  // Validate offset: non-negative integer
  const rawOffset = url.searchParams.get('offset')
  let offset = 0
  if (rawOffset !== null) {
    const n = parseInt(rawOffset, 10)
    if (isNaN(n) || n < 0) {
      return Response.json(
        { error: 'offset must be a non-negative integer' },
        { status: 400 }
      )
    }
    offset = n
  }

  // Validate direction: must be inbound, outbound, or omitted
  const rawDirection = url.searchParams.get('direction')
  let direction: string | null = null
  if (rawDirection !== null && rawDirection !== '') {
    if (rawDirection !== 'inbound' && rawDirection !== 'outbound') {
      return Response.json(
        { error: 'direction must be "inbound" or "outbound"' },
        { status: 400 }
      )
    }
    direction = rawDirection
  }

  const query = url.searchParams.get('query')?.trim()

  // Normalize label to lowercase for consistent filtering
  const rawLabel = url.searchParams.get('label')?.trim()
  const label = rawLabel ? rawLabel.toLowerCase() : undefined
  // Optional strict validation: reject unknown labels (soft reject — return empty)
  const VALID_LABELS = ['code', 'newsletter', 'notification', 'personal']
  if (label && !VALID_LABELS.includes(label)) {
    return Response.json(
      { error: `Invalid label. Must be one of: ${VALID_LABELS.join(', ')}` },
      { status: 400 }
    )
  }

  // Validate mode: must be keyword, semantic, or hybrid
  const rawMode = url.searchParams.get('mode') ?? 'keyword'
  if (rawMode !== 'keyword' && rawMode !== 'semantic' && rawMode !== 'hybrid') {
    return Response.json(
      { error: 'mode must be "keyword", "semantic", or "hybrid"' },
      { status: 400 }
    )
  }
  const mode: 'keyword' | 'semantic' | 'hybrid' = rawMode

  // Semantic-only mode
  if (query && mode === 'semantic') {
    return handleSemanticSearch(env, to, query, direction, label, limit, offset)
  }

  // Hybrid mode: run FTS5 + semantic in parallel, merge with RRF
  if (query && mode === 'hybrid') {
    return handleHybridSearch(env, to, query, direction, label, limit, offset)
  }

  // Default: keyword (FTS5) mode
  return handleKeywordSearch(env, to, query, direction, label, limit, offset)
}

// ---------------------------------------------------------------------------
// Keyword search (existing FTS5 logic)
// ---------------------------------------------------------------------------

async function handleKeywordSearch(
  env: Env, to: string, query: string | undefined,
  direction: string | null, label: string | undefined,
  limit: number, offset: number
): Promise<Response> {
  const primary = buildEmailListQuery(to, query, direction, label, limit, offset)
  const rows = await executeEmailListQuery(env, primary, query ? () => {
    return buildEmailListQuery(to, query, direction, label, limit, offset, true)
  } : undefined)

  return Response.json({
    emails: rows.results.map(formatEmailRow),
    search_mode: 'keyword',
  })
}

// ---------------------------------------------------------------------------
// Semantic search (Vectorize only)
// ---------------------------------------------------------------------------

async function handleSemanticSearch(
  env: Env, to: string, query: string,
  direction: string | null, label: string | undefined,
  limit: number, offset: number
): Promise<Response> {
  const results = await semanticSearch(env, query, to, limit + offset)

  if (results.length === 0) {
    return Response.json({
      emails: [],
      search_mode: 'semantic',
      hint: env.VECTORIZE ? undefined : 'Semantic search requires Vectorize binding. Configure [ai] and [[vectorize]] in wrangler.toml.',
    })
  }

  // Fetch emails by IDs from Vectorize results
  const paged = results.slice(offset, offset + limit)
  const ids = paged.map((r) => r.id)
  const scoreMap = new Map(paged.map((r) => [r.id, r.score]))

  const emails = await fetchEmailsByIds(env, ids, to, direction, label)

  // Sort by Vectorize score (descending)
  emails.sort((a, b) => (scoreMap.get(b.id as string) ?? 0) - (scoreMap.get(a.id as string) ?? 0))

  return Response.json({ emails, search_mode: 'semantic' })
}

// ---------------------------------------------------------------------------
// Hybrid search (FTS5 + Vectorize → RRF merge)
// ---------------------------------------------------------------------------

async function handleHybridSearch(
  env: Env, to: string, query: string,
  direction: string | null, label: string | undefined,
  limit: number, offset: number
): Promise<Response> {
  const fetchSize = (limit + offset) * 2

  // Run FTS5 and semantic in parallel
  const [ftsEmails, semanticResults] = await Promise.all([
    fetchFtsResults(env, to, query, direction, label, fetchSize),
    semanticSearch(env, query, to, fetchSize),
  ])

  // Build rank maps
  const ftsRanks = new Map(ftsEmails.map((e, i) => [e.id as string, i + 1]))
  const semRanks = new Map(semanticResults.map((r, i) => [r.id, i + 1]))

  // Collect all unique IDs
  const allIds = new Set([...ftsRanks.keys(), ...semRanks.keys()])

  // Calculate RRF scores (k=60)
  const K = 60
  const scored = [...allIds].map((id) => ({
    id,
    score: (ftsRanks.has(id) ? 1 / (K + ftsRanks.get(id)!) : 0)
           + (semRanks.has(id) ? 1 / (K + semRanks.get(id)!) : 0),
  }))

  scored.sort((a, b) => b.score - a.score)
  const pagedIds = scored.slice(offset, offset + limit).map((s) => s.id)

  if (pagedIds.length === 0) {
    return Response.json({ emails: [], search_mode: 'hybrid' })
  }

  const emails = await fetchEmailsByIds(env, pagedIds, to, direction, label)

  // Re-sort by RRF score
  const rrfMap = new Map(scored.map((s) => [s.id, s.score]))
  emails.sort((a, b) => (rrfMap.get(b.id as string) ?? 0) - (rrfMap.get(a.id as string) ?? 0))

  return Response.json({ emails, search_mode: 'hybrid' })
}

// ---------------------------------------------------------------------------
// Shared FTS query builder (used by keyword + hybrid search)
// ---------------------------------------------------------------------------

/**
 * Build the WHERE clause fragment for full-text search.
 * FTS5 trigram tokenizer requires queries of at least 3 characters.
 * For shorter queries (common in CJK where 2-char words are frequent),
 * fall back to LIKE on subject and body_text so they still match.
 */
function buildFtsWhereClause(query: string): { clause: string; clauseParams: (string | number)[] } {
  const ftsQuery = '"' + query.replace(/"/g, '""') + '"'
  const like = buildLikePattern(query)
  const useShortFallback = [...query].length < 3

  if (useShortFallback) {
    return buildLikeWhereClause(query)
  }

  return {
    clause: ` AND (
      rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)
      OR from_address LIKE ? ESCAPE '\\'
      OR to_address LIKE ? ESCAPE '\\'
      OR subject LIKE ? ESCAPE '\\'
      OR body_text LIKE ? ESCAPE '\\'
    )`,
    clauseParams: [ftsQuery, like, like, like, like],
  }
}

function buildLikeWhereClause(query: string): { clause: string; clauseParams: (string | number)[] } {
  const like = buildLikePattern(query)
  return {
    clause: ` AND (
      from_address LIKE ? ESCAPE '\\'
      OR to_address LIKE ? ESCAPE '\\'
      OR subject LIKE ? ESCAPE '\\'
      OR body_text LIKE ? ESCAPE '\\'
    )`,
    clauseParams: [like, like, like, like],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLikePattern(query: string): string {
  return `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
}

type QueryParts = {
  sql: string
  params: (string | number)[]
  usesFts: boolean
}

function buildEmailListQuery(
  to: string,
  query: string | undefined,
  direction: string | null,
  label: string | undefined,
  limit: number,
  offset: number,
  forceLike = false
): QueryParts {
  let sql = `
    SELECT id, mailbox, from_address, from_name, subject, code, direction, status,
           received_at, has_attachments, attachment_count
    FROM emails WHERE mailbox = ?`
  const params: (string | number)[] = [to]

  appendEmailFilters({ direction, label, query, forceLike, params, sql }, (nextSql) => {
    sql = nextSql
  })

  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  return { sql, params, usesFts: Boolean(query && !forceLike && [...query].length >= 3) }
}

async function fetchFtsResults(
  env: Env, to: string, query: string,
  direction: string | null, label: string | undefined,
  limit: number
): Promise<Record<string, unknown>[]> {
  let sql = 'SELECT id FROM emails WHERE mailbox = ?'
  const params: (string | number)[] = [to]

  appendEmailFilters({ direction, label, query, forceLike: false, params, sql }, (nextSql) => {
    sql = nextSql
  })

  sql += ' ORDER BY received_at DESC LIMIT ?'
  params.push(limit)

  const rows = await executeEmailListQuery(
    env,
    { sql, params, usesFts: [...query].length >= 3 },
    () => {
      let fallbackSql = 'SELECT id FROM emails WHERE mailbox = ?'
      const fallbackParams: (string | number)[] = [to]
      appendEmailFilters({ direction, label, query, forceLike: true, params: fallbackParams, sql: fallbackSql }, (nextSql) => {
        fallbackSql = nextSql
      })
      fallbackSql += ' ORDER BY received_at DESC LIMIT ?'
      fallbackParams.push(limit)
      return { sql: fallbackSql, params: fallbackParams, usesFts: false }
    }
  )
  return rows.results ?? []
}

function appendEmailFilters(
  input: {
    direction: string | null
    label: string | undefined
    query: string | undefined
    forceLike: boolean
    params: (string | number)[]
    sql: string
  },
  setSql: (sql: string) => void
): void {
  let { sql } = input

  if (input.direction === 'inbound' || input.direction === 'outbound') {
    sql += ' AND direction = ?'
    input.params.push(input.direction)
  }

  if (input.label) {
    sql += ' AND id IN (SELECT email_id FROM email_labels WHERE label = ?)'
    input.params.push(input.label)
  }

  if (input.query) {
    const { clause, clauseParams } = input.forceLike
      ? buildLikeWhereClause(input.query)
      : buildFtsWhereClause(input.query)
    sql += clause
    input.params.push(...clauseParams)
  }

  setSql(sql)
}

async function executeEmailListQuery(
  env: Env,
  primary: QueryParts,
  fallback?: () => QueryParts
): Promise<{ results: Record<string, unknown>[] }> {
  try {
    return await env.DB.prepare(primary.sql).bind(...primary.params).all()
  } catch (error) {
    if (!primary.usesFts || !fallback) {
      throw error
    }
    console.warn('FTS keyword search failed; retrying with LIKE fallback', error)
    const retry = fallback()
    return await env.DB.prepare(retry.sql).bind(...retry.params).all()
  }
}

async function fetchEmailsByIds(
  env: Env, ids: string[], to: string,
  direction: string | null, label: string | undefined
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(', ')
  let sql = `
    SELECT id, mailbox, from_address, from_name, subject, code, direction, status,
           received_at, has_attachments, attachment_count
    FROM emails WHERE mailbox = ? AND id IN (${placeholders})`
  const params: (string | number)[] = [to, ...ids]

  if (direction === 'inbound' || direction === 'outbound') {
    sql += ' AND direction = ?'
    params.push(direction)
  }
  if (label) {
    sql += ' AND id IN (SELECT email_id FROM email_labels WHERE label = ?)'
    params.push(label)
  }

  const rows = await env.DB.prepare(sql).bind(...params).all()
  return (rows.results ?? []).map(formatEmailRow)
}

function formatEmailRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    has_attachments: Boolean((row as { has_attachments?: number }).has_attachments),
    attachment_count: (row as { attachment_count?: number }).attachment_count ?? 0,
  }
}
