import type { SendOptions, SendProvider, SendResult } from './types.js'
import { loadConfig, resolveApiKey } from './config.js'
import { createResendProvider } from '../providers/send/resend.js'
import { createHostedSendProvider } from '../providers/send/hosted.js'
import { prepareSendAttachments } from './send-attachments.js'
import { getStorage } from './storage.js'

function resolveProvider(): SendProvider {
  const config = loadConfig()

  // Priority:
  // 1. api_key (hosted mode) → cloud send via /v1/send (100 free/month + x402)
  // 2. resend_api_key → direct Resend (unlimited, self-managed)
  // 3. Nothing configured → error

  if (config.api_key) {
    return createHostedSendProvider(config.api_key)
  }

  if (config.resend_api_key) {
    return createResendProvider(config.resend_api_key)
  }

  if (config.send_provider === 'resend') {
    throw new Error('resend_api_key not configured. Run: mails config set resend_api_key <key>')
  }

  throw new Error('No send provider configured. Run: mails claim <name> or mails config set resend_api_key <key>')
}

export async function send(options: SendOptions): Promise<SendResult> {
  const config = loadConfig()
  const provider = resolveProvider()

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

  const result = await provider.send({
    from,
    to,
    subject: options.subject,
    text: options.text,
    html: options.html,
    replyTo: options.replyTo,
    headers: options.headers,
    attachments,
  })

  // Record outbound email in local storage (best-effort, skip for remote)
  try {
    const storage = await getStorage()
    if (storage.name !== 'remote') {
      await storage.saveEmail({
        id: result.id,
        mailbox: from,
        from_address: from,
        from_name: '',
        to_address: to.join(', '),
        subject: options.subject,
        body_text: options.text ?? '',
        body_html: options.html ?? '',
        code: null,
        headers: options.headers ?? {},
        metadata: { provider: result.provider },
        direction: 'outbound',
        status: 'sent',
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    }
  } catch {
    // Best-effort: don't fail the send if storage write fails
  }

  return result
}
