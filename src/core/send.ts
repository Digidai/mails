import type { SendOptions, SendProvider, SendResult } from './types.js'
import { loadConfig } from './config.js'
import { createResendProvider } from '../providers/send/resend.js'
import { createHostedSendProvider } from '../providers/send/hosted.js'
import { prepareSendAttachments } from './send-attachments.js'

function resolveProvider(): SendProvider {
  const config = loadConfig()

  // Priority:
  // 1. User has their own resend_api_key → direct Resend (unlimited)
  // 2. User has api_key (hosted mode) → cloud send via /v1/send (100 free/month + x402)
  // 3. Explicit send_provider=resend without key → error
  // 4. Nothing configured → error

  if (config.resend_api_key) {
    return createResendProvider(config.resend_api_key)
  }

  if (config.api_key) {
    return createHostedSendProvider(config.api_key)
  }

  if (config.send_provider === 'resend') {
    throw new Error('resend_api_key not configured. Run: mails config set resend_api_key <key>')
  }

  throw new Error('No send provider configured. Run: mails claim <name> or mails config set resend_api_key <key>')
}

export async function send(options: SendOptions): Promise<SendResult> {
  const config = loadConfig()
  const provider = resolveProvider()

  const from = options.from ?? config.default_from
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
