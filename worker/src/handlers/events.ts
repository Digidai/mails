import type { Env } from '../types'

/**
 * SSE event stream handler.
 * GET /v1/events — real-time event stream for a mailbox.
 *
 * Uses the SSE reconnect pattern to work within Cloudflare Workers' 30s limit:
 * 1. Queries D1 for events since `since` parameter
 * 2. Streams any found events as SSE
 * 3. If no events, polls D1 every 2s for up to 25 seconds
 * 4. Closes connection. Client auto-reconnects via EventSource using Last-Event-ID.
 *
 * Query params:
 *   ?mailbox= — filter by mailbox (optional if auth is mailbox-scoped)
 *   ?types= — comma-separated event types to filter (default: all)
 *   ?since= — ISO 8601 timestamp, replay events since this time
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
      const send = (event: string, data: unknown, id?: string) => {
        if (closed) return
        try {
          let msg = ''
          if (id) msg += `id: ${id}\n`
          msg += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          controller.enqueue(encoder.encode(msg))
        } catch { closed = true }
      }

      // Send initial connection event
      send('connected', { mailbox: mb, since: lastEventTime })

      // Poll for up to 25 seconds (within Workers' 30s limit)
      const deadline = Date.now() + 25_000
      const MAX_POLLS = 13 // 25s / 2s = ~12.5 polls

      for (let poll = 0; poll < MAX_POLLS && !closed && Date.now() < deadline; poll++) {
        try {
          const query = 'SELECT * FROM events WHERE mailbox = ? AND created_at > ? ORDER BY created_at ASC LIMIT 50'
          const rows = await env.DB.prepare(query).bind(mb, lastEventTime).all<{
            id: string
            mailbox: string
            event_type: string
            payload: string
            created_at: string
          }>()

          let sentAny = false
          for (const row of rows.results ?? []) {
            if (typesFilter.length > 0 && !typesFilter.includes(row.event_type)) continue
            send(row.event_type, JSON.parse(row.payload), row.id)
            lastEventTime = row.created_at
            sentAny = true
          }

          // If we found events, send them and close — client will reconnect
          if (sentAny) break

          // Send keepalive comment
          if (!closed) {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }
        } catch {
          send('error', { message: 'Poll failed' })
          break
        }

        // Wait 2 seconds between polls (unless this is the last iteration)
        if (poll < MAX_POLLS - 1 && Date.now() + 2000 < deadline) {
          await new Promise(r => setTimeout(r, 2000))
        }
      }

      // Close the stream — client will reconnect via EventSource
      if (!closed) {
        send('done', { last_event_time: lastEventTime })
        try { controller.close() } catch {}
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
