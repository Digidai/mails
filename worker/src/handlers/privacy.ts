import type { Env } from '../types'

const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function hmacIdentifier(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

export async function tokenSubjectId(token: string, env: Env): Promise<string> {
  if (env.ABUSE_HASH_SECRET) {
    return hmacIdentifier(`token:${token}`, env.ABUSE_HASH_SECRET)
  }
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(`token:${token}`)))
}

export function getClientIp(request: Request): string | null {
  const direct = request.headers.get('CF-Connecting-IP') ?? request.headers.get('True-Client-IP')
  if (direct?.trim()) return direct.trim().slice(0, 128)
  const forwarded = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
  return forwarded ? forwarded.slice(0, 128) : null
}

export type ClientMetadata = {
  source: string
  clientName: string
  clientVersion: string | null
  flow: string
}

function cleanHeader(value: string | null, fallback: string, maxLength = 64): string {
  if (!value) return fallback
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._:/-]/g, '-')
  return cleaned.slice(0, maxLength) || fallback
}

export function getClientMetadata(request: Request): ClientMetadata {
  return {
    source: cleanHeader(request.headers.get('X-Mails-Source'), 'unknown'),
    clientName: cleanHeader(request.headers.get('X-Mails-Client'), 'unknown'),
    clientVersion: cleanHeader(request.headers.get('X-Mails-Client-Version'), '', 32) || null,
    flow: cleanHeader(request.headers.get('X-Mails-Flow'), 'api'),
  }
}

export function readNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
