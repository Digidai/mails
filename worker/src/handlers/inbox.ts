import type { Env } from '../types'
import { semanticSearch } from '../embeddings'

export async function handleInbox(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const to = mailbox ?? url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0
  const direction = url.searchParams.get('direction')
  const query = url.searchParams.get('query')?.trim()
  const label = url.searchParams.get('label')?.trim()
  const mode = (url.searchParams.get('mode') ?? 'keyword') as 'keyword' | 'semantic' | 'hybrid'

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
  let sql = `
    SELECT id, mailbox, from_address, from_name, subject, code, direction, status,
           received_at, has_attachments, attachment_count
    FROM emails WHERE mailbox = ?`
  const params: (string | number)[] = [to]

  if (direction === 'inbound' || direction === 'outbound') {
    sql += ' AND direction = ?'
    params.push(direction)
  }

  if (label) {
    sql += ' AND id IN (SELECT email_id FROM email_labels WHERE label = ?)'
    params.push(label)
  }

  if (query) {
    const ftsQuery = '"' + query.replace(/"/g, '""') + '"'
    const likeQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_')
    sql += ` AND (
      rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)
      OR from_address LIKE ? ESCAPE '\\'
      OR to_address LIKE ? ESCAPE '\\'
    )`
    params.push(ftsQuery, `%${likeQuery}%`, `%${likeQuery}%`)
  }

  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = await env.DB.prepare(sql).bind(...params).all()

  return Response.json({
    emails: rows.results.map(formatEmailRow),
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
// Helpers
// ---------------------------------------------------------------------------

async function fetchFtsResults(
  env: Env, to: string, query: string,
  direction: string | null, label: string | undefined,
  limit: number
): Promise<Record<string, unknown>[]> {
  let sql = 'SELECT id FROM emails WHERE mailbox = ?'
  const params: (string | number)[] = [to]

  if (direction === 'inbound' || direction === 'outbound') {
    sql += ' AND direction = ?'
    params.push(direction)
  }
  if (label) {
    sql += ' AND id IN (SELECT email_id FROM email_labels WHERE label = ?)'
    params.push(label)
  }

  const ftsQuery = '"' + query.replace(/"/g, '""') + '"'
  const likeQuery = query.replace(/%/g, '\\%').replace(/_/g, '\\_')
  sql += ` AND (
    rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)
    OR from_address LIKE ? ESCAPE '\\'
    OR to_address LIKE ? ESCAPE '\\'
  )`
  params.push(ftsQuery, `%${likeQuery}%`, `%${likeQuery}%`)
  sql += ' ORDER BY received_at DESC LIMIT ?'
  params.push(limit)

  const rows = await env.DB.prepare(sql).bind(...params).all()
  return rows.results ?? []
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
