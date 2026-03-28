/**
 * Auto-detect labels for an incoming email based on headers and content.
 * Returns an array of label strings. Multiple labels can apply.
 */

const NOREPLY_PATTERN = /^no[-_.]?reply@/i
const NOTIFICATION_SENDERS = /^(notifications?|alerts?|mailer-daemon|bounce)@/i

// Case-insensitive header lookup — postal-mime preserves original casing
// (e.g. "List-Unsubscribe" vs "list-unsubscribe"), so we must normalize.
function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

export function detectLabels(
  fromAddress: string,
  headers: Record<string, string>,
  code: string | null
): string[] {
  const labels: string[] = []

  // Newsletter: has List-Unsubscribe or List-Id header
  if (getHeader(headers, 'List-Unsubscribe') || getHeader(headers, 'List-Id')) {
    labels.push('newsletter')
  }

  // Notification: from noreply/no-reply or common notification senders
  if (NOREPLY_PATTERN.test(fromAddress) || NOTIFICATION_SENDERS.test(fromAddress)) {
    labels.push('notification')
  }

  // Code: verification code was extracted
  if (code !== null) {
    labels.push('code')
  }

  // Personal: none of the above matched
  if (labels.length === 0) {
    labels.push('personal')
  }

  return labels
}
