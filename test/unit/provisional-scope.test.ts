import { describe, expect, test } from 'bun:test'
import { isProvisionalRouteAllowed } from '../../worker/src/index'

describe('provisional capability boundary', () => {
  test('allows only receive and read workflows', () => {
    expect(isProvisionalRouteAllowed('/api/inbox', 'GET')).toBe(true)
    expect(isProvisionalRouteAllowed('/api/code', 'GET')).toBe(true)
    expect(isProvisionalRouteAllowed('/api/search', 'GET')).toBe(true)
    expect(isProvisionalRouteAllowed('/api/extract', 'POST')).toBe(true)
    expect(isProvisionalRouteAllowed('/api/mailbox', 'DELETE')).toBe(true)
  })

  test('denies outbound and account expansion workflows', () => {
    expect(isProvisionalRouteAllowed('/api/send', 'POST')).toBe(false)
    expect(isProvisionalRouteAllowed('/api/attachment', 'GET')).toBe(false)
    expect(isProvisionalRouteAllowed('/api/domains', 'POST')).toBe(false)
    expect(isProvisionalRouteAllowed('/api/mailbox', 'PATCH')).toBe(false)
    expect(isProvisionalRouteAllowed('/api/mailbox/routes', 'PUT')).toBe(false)
    expect(isProvisionalRouteAllowed('/api/claim/auto', 'POST')).toBe(false)
    expect(isProvisionalRouteAllowed('/api/mailbox/pause', 'PATCH')).toBe(false)
  })
})
