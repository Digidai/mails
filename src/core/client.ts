import { VERSION } from '../version.js'

export function clientHeaders(
  flow: string,
  source = 'cli',
  client = 'mails-agent',
): Record<string, string> {
  return {
    'X-Mails-Client': client,
    'X-Mails-Client-Version': VERSION,
    'X-Mails-Source': source,
    'X-Mails-Flow': flow,
  }
}
