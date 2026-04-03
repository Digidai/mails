import type { Env } from '../types'

/**
 * SSE event stream handler.
 * GET /v1/events — real-time event stream for a mailbox.
 * Agent connects once and receives events as they happen. No public URL needed.
 *
 * Query params:
 *   ?mailbox= — filter by mailbox (optional if auth is mailbox-scoped)
 *   ?types= — comma-separated event types to filter (default: all)
 *   ?since= — ISO 8601 timestamp, replay events since this time
 *
 * Events are stored in the events table and streamed via SSE.
 * The connection stays open and polls every 2 seconds for new events.
 */
export function handleEvents(url: URL, env: Env, mailbox?: string): Response {
  const mb = mailbox ?? url.searchParams.get('mailbox') ?? url.searchParams.get('to') ?? ''
  if (!mb) {
    return Response.json({ error: 'Mailbox required' }, { status: 400 })
  }

  const typesFilter = url.searchParams.get('types')?.split(',').map(t => t.trim()) ?? []
  const since = url.searchParams.get('since') ?? new Date(Date.now() - 60_000).toISOString()

  let lastEventTime = since
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { closed = true }
      }

      // Send initial connection event
      send('connected', { mailbox: mb, since: lastEventTime })

      // Poll loop — runs until client disconnects
      while (!closed) {
        try {
          let query = 'SELECT * FROM events WHERE mailbox = ? AND created_at > ? ORDER BY created_at ASC LIMIT 50'
          const params: (string)[] = [mb, lastEventTime]

          const rows = await env.DB.prepare(query).bind(...params).all<{
            id: string
            mailbox: string
            event_type: string
            payload: string
            created_at: string
          }>()

          for (const row of rows.results ?? []) {
            if (typesFilter.length > 0 && !typesFilter.includes(row.event_type)) continue
            send(row.event_type, JSON.parse(row.payload))
            lastEventTime = row.created_at
          }

          // Send keepalive every poll cycle
          if ((rows.results?.length ?? 0) === 0) {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }
        } catch (err) {
          send('error', { message: 'Poll failed' })
        }

        // Wait 2 seconds between polls
        await new Promise(r => setTimeout(r, 2000))
      }
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

/**
 * Record an event to the events table for SSE consumers.
 * Called from email receive handler and send handler.
 */
export async function recordEvent(
  env: Env,
  eventType: string,
  mailbox: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO events (id, mailbox, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), mailbox, eventType, JSON.stringify(payload), new Date().toISOString()).run()
  } catch (err) {
    console.error(`Event record failed: ${err}`)
  }
}
