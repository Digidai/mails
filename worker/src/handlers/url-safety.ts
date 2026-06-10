export function validateWebhookUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'webhook_url is not a valid URL'
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'webhook_url must use http:// or https:// protocol'
  }

  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isNumericHost(host) ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    return 'webhook_url must not point to private or local addresses'
  }

  return null
}

/** A bare integer host (decimal/hex) like 2130706433 or 0x7f000001 = 127.0.0.1. */
function isNumericHost(host: string): boolean {
  return /^(0x[0-9a-f]+|[0-9]+)$/i.test(host)
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  // Only treat as an IPv4 literal when every part is an integer; otherwise it's a
  // normal 4-label domain (e.g. a.b.c.example) and not subject to IP filtering.
  if (!parts.every((p) => /^(0x[0-9a-f]+|[0-9]+)$/i.test(p))) return false
  // Non-canonical octets (leading zero / hex) can be re-read as octal/hex by the
  // resolver (0177.0.0.1 => 127.0.0.1) — block conservatively.
  if (parts.some((p) => /^0x/i.test(p) || (p.length > 1 && p[0] === '0'))) return true
  const octets = parts.map((part) => Number(part))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

/** Block IPv6 loopback, link-local (fe80::/10), ULA (fc00::/7), and IPv4-mapped. */
function isPrivateIpv6(rawHost: string): boolean {
  if (!rawHost.includes(':')) return false // not an IPv6 literal
  const h = rawHost.replace(/^\[/, '').replace(/\]$/, '')
  return (
    h === '::1' ||
    h.startsWith('fe80') ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    /::ffff:/i.test(h)
  )
}
