import type { SendProvider, SendResult } from '../../core/types.js'

export function createWorkerSendProvider(url: string, token?: string): SendProvider {
  return {
    name: 'worker',

    async send(options): Promise<SendResult> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const body: Record<string, unknown> = {
        from: options.from,
        to: options.to,
        subject: options.subject,
      }
      if (options.text) body.text = options.text
      if (options.html) body.html = options.html
      if (options.replyTo) body.reply_to = options.replyTo
      if (options.headers && Object.keys(options.headers).length > 0) {
        body.headers = options.headers
      }
      if (options.attachments?.length) {
        body.attachments = options.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType ? { content_type: a.contentType } : {}),
          ...(a.contentId ? { content_id: a.contentId } : {}),
        }))
      }

      let res: Response
      try {
        res = await fetch(`${url}/api/send`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      } catch (err) {
        throw new Error(`Cannot connect to Worker at ${url}: ${err instanceof Error ? err.message : err}`)
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(`Worker send error: ${data.error ?? res.statusText}`)
      }

      const data = await res.json() as { id: string; provider_id?: string }
      return { id: data.id, provider: 'worker', provider_id: data.provider_id }
    },
  }
}
