import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { send } from '../../src/core/send'
import { saveConfig } from '../../src/core/config'
import type { MailsConfig } from '../../src/core/types'

const BASE_CONFIG: MailsConfig = {
  mode: 'hosted',
  domain: 'mails0.com',
  mailbox: '',
  send_provider: 'resend',
  storage_provider: 'sqlite',
  resend_api_key: 're_test',
  default_from: 'Bot <bot@test.com>',
}

describe('send', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    saveConfig({ ...BASE_CONFIG })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    saveConfig({ ...BASE_CONFIG })
  })

  test('sends email using config', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'msg_1' }))
    }) as typeof fetch

    const result = await send({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'World',
    })

    expect(result.id).toBe('msg_1')
    expect(result.provider).toBe('resend')
  })

  test('uses explicit from over default_from', async () => {
    let sentFrom = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      sentFrom = body.from
      return new Response(JSON.stringify({ id: 'msg_2' }))
    }) as typeof fetch

    await send({
      from: 'Custom <custom@test.com>',
      to: 'user@example.com',
      subject: 'Test',
      text: 'body',
    })

    expect(sentFrom).toBe('Custom <custom@test.com>')
  })

  test('throws when no provider configured (no resend_api_key)', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('No send provider configured')
  })

  test('throws when no from address', async () => {
    saveConfig({ ...BASE_CONFIG, default_from: undefined })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('No "from" address')
  })

  test('throws when no body', async () => {
    expect(
      send({ to: 'a@b.com', subject: 'Test' })
    ).rejects.toThrow('Either text or html body is required')
  })

  test('accepts string or array for to', async () => {
    let sentTo: string[] = []
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      sentTo = body.to
      return new Response(JSON.stringify({ id: 'msg_3' }))
    }) as typeof fetch

    await send({ to: 'single@test.com', subject: 'Test', text: 'hi' })
    expect(sentTo).toEqual(['single@test.com'])

    await send({ to: ['a@test.com', 'b@test.com'], subject: 'Test', text: 'hi' })
    expect(sentTo).toEqual(['a@test.com', 'b@test.com'])
  })

  test('throws when no provider configured', async () => {
    saveConfig({ ...BASE_CONFIG, send_provider: 'unknown', resend_api_key: undefined, api_key: undefined })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('No send provider configured')
  })

  test('uses hosted provider when api_key set and no resend_api_key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: undefined,
      api_key: 'mk_hosted_test',
      default_from: 'agent@mails0.com',
    })

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['Authorization']
      expect(auth).toBe('Bearer mk_hosted_test')
      return new Response(JSON.stringify({ id: 'hosted_1', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Hosted', text: 'test' })
    expect(result.id).toBe('hosted_1')
    expect(result.provider).toBe('mails0.com')
  })

  test('api_key takes priority over resend_api_key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: 're_should_not_use',
      api_key: 'mk_priority',
      default_from: 'agent@mails0.com',
    })

    let usedUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      usedUrl = url
      return new Response(JSON.stringify({ id: 'hosted_priority', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Priority', text: 'test' })
    expect(usedUrl).toContain('/v1/send')
    expect(result.provider).toBe('mails0.com')
  })

  test('throws when send_provider set but no credentials configured', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined, api_key: undefined, send_provider: 'resend' })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('No send provider configured')
  })
})
