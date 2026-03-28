import { extractCode } from './extract-code'
import { parseIncomingEmail } from './mime'
import { attachmentContentToUint8Array } from './mime'
import type { Env } from './types'
import { resolveAuth } from './handlers/auth'
import { handleInbox } from './handlers/inbox'
import { handleGetCode } from './handlers/code'
import { handleGetEmail, handleDeleteEmail } from './handlers/email'
import { handleSend, parseFromName } from './handlers/send'
import { handleGetAttachment } from './handlers/attachment'
import { handleGetThreads, handleGetThread } from './handlers/threads'
import { handleExtract } from './handlers/extract'
import { fireWebhook, getWebhookUrl } from './handlers/webhook'
import { resolveThreadId } from './threading'
import { detectLabels } from './auto-label'

export type { Env } from './types'

const R2_UPLOAD_THRESHOLD = 100_000 // 100KB

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    let response: Response

    // /health is always public
    if (url.pathname === '/health') {
      response = Response.json({ ok: true })
    } else if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
      // /v1/* = hosted API (always requires auth_tokens, mailbox-scoped)
      // /api/* = self-hosted API (supports AUTH_TOKEN, public fallback)
      const isV1 = url.pathname.startsWith('/v1/')
      const route = isV1 ? url.pathname.replace('/v1/', '/api/') : url.pathname

      const auth = await resolveAuth(request, env, isV1)
      if (auth === null) {
        response = Response.json({ error: 'Unauthorized' }, { status: 401 })
      } else {
        // When mailbox is known from token, use it; otherwise fall through to ?to= param
        const mailbox = auth.mailbox ?? undefined

        // /v1/* always requires mailbox binding (except /v1/me)
        if (isV1 && !mailbox && route !== '/api/me') {
          response = Response.json({ error: 'Unauthorized' }, { status: 401 })
        } else {
          try {
            switch (route) {
              case '/api/inbox':
                response = await handleInbox(url, env, mailbox)
                break
              case '/api/code':
                response = await handleGetCode(url, env, mailbox)
                break
              case '/api/email':
                if (request.method === 'DELETE') {
                  response = await handleDeleteEmail(url, env, mailbox)
                } else {
                  response = await handleGetEmail(url, env, mailbox)
                }
                break
              case '/api/send':
                if (request.method !== 'POST') {
                  response = Response.json({ error: 'Method not allowed' }, { status: 405 })
                  break
                }
                response = await handleSend(request, env, mailbox)
                break
              case '/api/me':
                response = Response.json({
                  worker: 'mails-worker',
                  mailbox: mailbox ?? null,
                  send: !!env.RESEND_API_KEY,
                })
                break
              case '/api/attachment':
                response = await handleGetAttachment(url, env, mailbox)
                break
              case '/api/threads':
                response = await handleGetThreads(url, env, mailbox)
                break
              case '/api/thread':
                response = await handleGetThread(url, env, mailbox)
                break
              case '/api/extract':
                if (request.method !== 'POST') {
                  response = Response.json({ error: 'Method not allowed' }, { status: 405 })
                  break
                }
                response = await handleExtract(request, url, env, mailbox)
                break
              default:
                response = Response.json({ error: 'Not found' }, { status: 404 })
            }
          } catch (err) {
            console.error(`API error ${url.pathname}:`, err)
            // Never expose internal error details to clients
            response = Response.json(
              { error: 'Internal server error' },
              { status: 500 }
            )
          }
        }
      }
    } else {
      response = Response.json({ name: 'mails-worker' })
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value)
    }
    return response
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const to = message.to
    const from = message.from
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    try {
      const parsed = await parseIncomingEmail(await new Response(message.raw).arrayBuffer(), id, now)
      const subject = parsed.subject || message.headers.get('subject') || ''
      const code = extractCode(`${subject} ${parsed.bodyText}`)
      const fromName = parseFromName(message.headers.get('from') ?? from)

      // Threading: resolve thread_id from In-Reply-To / References headers
      const threadId = await resolveThreadId(parsed.inReplyTo, parsed.references, parsed.messageId, env.DB, to)

      // Auto-labeling
      const labels = detectLabels(from, parsed.headers, code)

      // Upload large attachments to R2
      for (const att of parsed.attachments) {
        if (att.raw_content && att.size_bytes && att.size_bytes > R2_UPLOAD_THRESHOLD && env.ATTACHMENTS) {
          const key = `${id}/${att.id}`
          try {
            await env.ATTACHMENTS.put(key, attachmentContentToUint8Array(att.raw_content))
            att.storage_key = key
            att.downloadable = true
            console.log(`R2 upload: ${key} (${att.size_bytes} bytes)`)
          } catch (err) {
            console.error(`R2 upload failed for ${key}:`, err)
          }
        }
      }

      const statements = [
        env.DB.prepare(`
          INSERT INTO emails (
            id, mailbox, from_address, from_name, to_address, subject,
            body_text, body_html, code, headers, metadata, message_id,
            thread_id, in_reply_to, "references",
            has_attachments, attachment_count, attachment_names, attachment_search_text,
            raw_storage_key, direction, status, received_at, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?)
        `).bind(
          id, to, from, fromName, to, subject,
          parsed.bodyText.slice(0, 50000),
          parsed.bodyHtml.slice(0, 100000),
          code,
          JSON.stringify(parsed.headers),
          JSON.stringify({}),
          parsed.messageId,
          threadId,
          parsed.inReplyTo,
          parsed.references,
          parsed.attachmentCount > 0 ? 1 : 0,
          parsed.attachmentCount,
          parsed.attachmentNames,
          parsed.attachmentSearchText,
          null, now, now
        ),
        ...parsed.attachments.map((attachment) =>
          env.DB.prepare(`
            INSERT INTO attachments (
              id, email_id, filename, content_type, size_bytes,
              content_disposition, content_id, mime_part_index,
              text_content, text_extraction_status, storage_key, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            attachment.id, attachment.email_id, attachment.filename,
            attachment.content_type, attachment.size_bytes,
            attachment.content_disposition, attachment.content_id,
            attachment.mime_part_index, attachment.text_content,
            attachment.text_extraction_status, attachment.storage_key,
            attachment.created_at
          )
        ),
      ]

      await env.DB.batch(statements)
      console.log(`Email received id=${id} to=${to} from=${from} subject="${subject.slice(0, 50)}" thread=${threadId.slice(0, 8)} labels=${labels.join(',')} attachments=${parsed.attachmentCount}`)

      // Insert auto-labels (separate batch — label failure should not block email storage)
      if (labels.length > 0) {
        try {
          await env.DB.batch(
            labels.map((label) =>
              env.DB.prepare(
                'INSERT INTO email_labels (id, email_id, label, source, created_at) VALUES (?, ?, ?, ?, ?)'
              ).bind(crypto.randomUUID(), id, label, 'auto', now)
            )
          )
        } catch (err) {
          console.error(`Label insertion failed for email ${id}:`, err)
        }
      }

      // Fire webhook (non-blocking via waitUntil)
      const webhookUrl = await getWebhookUrl(env, to)
      if (webhookUrl) {
        ctx.waitUntil(fireWebhook(env, {
          event: 'email.received',
          email_id: id,
          mailbox: to,
          from,
          subject,
          received_at: now,
          message_id: parsed.messageId,
          thread_id: threadId,
          labels,
          has_attachments: parsed.attachmentCount > 0,
          attachment_count: parsed.attachmentCount,
        }, webhookUrl))
      }
    } catch (err) {
      console.error(`Email processing failed for id=${id} to=${to} from=${from}:`, err)
    }
  },
} satisfies ExportedHandler<Env>
