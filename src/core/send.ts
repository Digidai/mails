import type { MailsConfig, SendOptions, SendProvider, SendResult } from './types.js'
import { loadConfig, resolveApiKey } from './config.js'
import { createResendProvider } from '../providers/send/resend.js'
import { createHostedSendProvider } from '../providers/send/hosted.js'
import { createWorkerSendProvider } from '../providers/send/worker.js'
import { prepareSendAttachments } from './send-attachments.js'

function resolveProvider(config: MailsConfig): SendProvider {
  // Priority:
  // 1. worker_url → send via Worker /api/send (self-hosted, recommended)
  // 2. api_key (hosted mode) → cloud send via /v1/send (100 free/month + x402)
  // 3. resend_api_key → direct Resend (unlimited, self-managed)
  // 4. Nothing configured → error

  if (config.worker_url) {
    return createWorkerSendProvider(config.worker_url, config.worker_token)
  }

  if (config.api_key) {
    return createHostedSendProvider(config.api_key)
  }

  if (config.resend_api_key) {
    return createResendProvider(config.resend_api_key)
  }

  throw new Error('No send provider configured. Run: mails claim <name> or set worker_url/resend_api_key')
}

export async function send(options: SendOptions): Promise<SendResult> {
  const config = loadConfig()
  const provider = resolveProvider(config)

  let from = options.from ?? config.default_from

  // Auto-fetch from address if using hosted mode and not configured
  if (!from && config.api_key) {
    from = await resolveApiKey(config.api_key) ?? undefined
  }

  if (!from) {
    throw new Error('No "from" address. Set default_from or pass --from')
  }

  const to = Array.isArray(options.to) ? options.to : [options.to]

  if (!options.text && !options.html) {
    throw new Error('Either text or html body is required')
  }

  const attachments = await prepareSendAttachments(options.attachments)

  return provider.send({
    from,
    to,
    subject: options.subject,
    text: options.text,
    html: options.html,
    replyTo: options.replyTo,
    headers: options.headers,
    attachments,
  })
}
