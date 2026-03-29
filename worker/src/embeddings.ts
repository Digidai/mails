/**
 * Semantic search via Workers AI embeddings + Cloudflare Vectorize.
 * All functions gracefully degrade when AI/VECTORIZE bindings are absent.
 */

import type { Env } from './types'

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5'
const MAX_TEXT_LENGTH = 8000

/**
 * Build embedding input text from email fields.
 */
export function buildEmbeddingText(
  subject: string,
  fromName: string,
  bodyText: string,
): string {
  const parts = [subject, fromName, bodyText.slice(0, MAX_TEXT_LENGTH)]
  return parts.filter(Boolean).join('\n')
}

/**
 * Generate embedding for a single email and upsert into Vectorize.
 * Designed for ctx.waitUntil() — non-blocking, silent on failure.
 */
export async function generateAndStoreEmbedding(
  env: Env,
  emailId: string,
  mailbox: string,
  subject: string,
  fromName: string,
  bodyText: string,
): Promise<void> {
  if (!env.AI || !env.VECTORIZE) return

  const text = buildEmbeddingText(subject, fromName, bodyText)
  if (!text.trim()) return

  try {
    const result = await env.AI.run(EMBEDDING_MODEL, { text: [text] })
    const values = (result as { data?: number[][] })?.data?.[0]
    if (!values || !Array.isArray(values)) {
      console.error(`Embedding: unexpected AI response for email ${emailId}`)
      return
    }

    await env.VECTORIZE.upsert([{
      id: emailId,
      values,
      metadata: { mailbox },
    }])
  } catch (err) {
    console.error(`Embedding error for email ${emailId}:`, err)
  }
}

/**
 * Query Vectorize for semantically similar emails.
 * Returns {id, score}[] sorted by relevance, or [] if unavailable.
 */
export async function semanticSearch(
  env: Env,
  query: string,
  mailbox: string,
  topK: number = 20,
): Promise<{ id: string; score: number }[]> {
  if (!env.AI || !env.VECTORIZE) return []

  try {
    const result = await env.AI.run(EMBEDDING_MODEL, { text: [query] })
    const queryVector = (result as { data?: number[][] })?.data?.[0]
    if (!queryVector) return []

    const matches = await env.VECTORIZE.query(queryVector, {
      topK,
      filter: { mailbox },
      returnMetadata: 'none',
    })

    return (matches.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score,
    }))
  } catch (err) {
    console.error('Semantic search error:', err)
    return []
  }
}
