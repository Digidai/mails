import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { send } from '../../src/core/send'
import { saveConfig } from '../../src/core/config'
import type { MailsConfig, Email } from '../../src/core/types'

const BASE_CONFIG: MailsConfig = {
  mode: 'hosted',
  domain: 'mails.dev',
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

  test('throws when no resend_api_key', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('resend_api_key not configured')
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
      default_from: 'agent@mails.dev',
    })

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['Authorization']
      expect(auth).toBe('Bearer mk_hosted_test')
      return new Response(JSON.stringify({ id: 'hosted_1', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Hosted', text: 'test' })
    expect(result.id).toBe('hosted_1')
    expect(result.provider).toBe('mails.dev')
  })

  test('api_key takes priority over resend_api_key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: 're_should_not_use',
      api_key: 'mk_priority',
      default_from: 'agent@mails.dev',
    })

    let usedUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      usedUrl = url
      return new Response(JSON.stringify({ id: 'hosted_priority', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Priority', text: 'test' })
    expect(usedUrl).toContain('/v1/send')
    expect(result.provider).toBe('mails.dev')
  })

  test('throws resend_api_key error when explicitly set as provider without key', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined, api_key: undefined, send_provider: 'resend' })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('resend_api_key not configured')
  })

  test('records outbound email in storage after successful send', async () => {
    let savedEmail: Email | null = null
    const saveEmailSpy = mock(async (email: Email) => { savedEmail = email })

    mock.module('../../src/core/storage.js', () => ({
      getStorage: async () => ({
        name: 'sqlite',
        init: async () => {},
        saveEmail: saveEmailSpy,
        getEmails: async () => [],
        searchEmails: async () => [],
        getEmail: async () => null,
        getCode: async () => null,
      }),
    }))

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'msg_stored' }))
    }) as typeof fetch

    saveConfig({ ...BASE_CONFIG })

    const { send: freshSend } = await import(`../../src/core/send.ts?storage_test_1`)

    const result = await freshSend({
      to: 'user@example.com',
      subject: 'Storage Test',
      text: 'should be recorded',
    })

    expect(result.id).toBe('msg_stored')
    expect(saveEmailSpy).toHaveBeenCalledTimes(1)
    expect(savedEmail).not.toBeNull()
    expect(savedEmail!.id).toBe('msg_stored')
    expect(savedEmail!.direction).toBe('outbound')
    expect(savedEmail!.status).toBe('sent')
    expect(savedEmail!.subject).toBe('Storage Test')
    expect(savedEmail!.to_address).toBe('user@example.com')
    expect(savedEmail!.from_address).toBe('Bot <bot@test.com>')
    expect(savedEmail!.body_text).toBe('should be recorded')
    expect(savedEmail!.metadata).toEqual({ provider: 'resend' })
  })

  test('skips storage recording for remote provider', async () => {
    const saveEmailSpy = mock(async () => {})

    mock.module('../../src/core/storage.js', () => ({
      getStorage: async () => ({
        name: 'remote',
        init: async () => {},
        saveEmail: saveEmailSpy,
        getEmails: async () => [],
        searchEmails: async () => [],
        getEmail: async () => null,
        getCode: async () => null,
      }),
    }))

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'msg_remote' }))
    }) as typeof fetch

    saveConfig({ ...BASE_CONFIG })

    const { send: freshSend } = await import(`../../src/core/send.ts?storage_test_2`)

    const result = await freshSend({
      to: 'user@example.com',
      subject: 'Remote Test',
      text: 'should not be recorded locally',
    })

    expect(result.id).toBe('msg_remote')
    expect(saveEmailSpy).not.toHaveBeenCalled()
  })

  test('send succeeds even if storage write fails', async () => {
    mock.module('../../src/core/storage.js', () => ({
      getStorage: async () => ({
        name: 'sqlite',
        init: async () => {},
        saveEmail: async () => { throw new Error('DB write failed') },
        getEmails: async () => [],
        searchEmails: async () => [],
        getEmail: async () => null,
        getCode: async () => null,
      }),
    }))

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'msg_resilient' }))
    }) as typeof fetch

    saveConfig({ ...BASE_CONFIG })

    const { send: freshSend } = await import(`../../src/core/send.ts?storage_test_3`)

    const result = await freshSend({
      to: 'user@example.com',
      subject: 'Resilient Test',
      text: 'should still succeed',
    })

    expect(result.id).toBe('msg_resilient')
    expect(result.provider).toBe('resend')
  })
})
