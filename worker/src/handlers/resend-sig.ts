/**
 * Verify Resend webhook signature (Svix).
 * Resend signs webhooks with svix-id, svix-timestamp, svix-signature headers.
 * See: https://resend.com/docs/dashboard/webhooks/introduction
 *
 * Shared by the delivery-status webhook and the inbound (email.received) webhook.
 */
export async function verifyResendSignature(
  request: Request,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const svixId = request.headers.get('svix-id')
  const svixTimestamp = request.headers.get('svix-timestamp')
  const svixSignature = request.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) return false

  // Reject timestamps older than 5 minutes
  const ts = parseInt(svixTimestamp, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > 300) return false

  // Svix secret is base64-encoded after "whsec_" prefix
  const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0))

  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))

  // svix-signature may contain multiple signatures separated by spaces (v1,xxx v1,yyy)
  const signatures = svixSignature.split(' ')
  return signatures.some(s => {
    const val = s.split(',')[1]
    return val !== undefined && timingSafeEqual(val, expected)
  })
}

/** Constant-time string comparison to avoid leaking secrets via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
