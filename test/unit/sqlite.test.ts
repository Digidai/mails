import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createSqliteProvider } from '../../src/providers/storage/sqlite'
import type { Email } from '../../src/core/types'

const TEST_DB = join(import.meta.dir, '..', '.test-mails.db')

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: crypto.randomUUID(),
    mailbox: 'agent@test.com',
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: 'agent@test.com',
    subject: 'Test email',
    body_text: 'Hello world',
    body_html: '<p>Hello world</p>',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('SQLite provider', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB)
    if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal')
    if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm')
  })

  afterEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB)
    if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal')
    if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm')
  })

  test('init creates database and table', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    expect(existsSync(TEST_DB)).toBe(true)
  })

  test('saveEmail and getEmail', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const email = makeEmail({ id: 'test-1', subject: 'Saved email' })
    await provider.saveEmail(email)

    const retrieved = await provider.getEmail('test-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe('test-1')
    expect(retrieved!.subject).toBe('Saved email')
    expect(retrieved!.from_address).toBe('sender@example.com')
    expect(retrieved!.direction).toBe('inbound')
  })

  test('getEmail returns null for nonexistent', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()
    expect(await provider.getEmail('nonexistent')).toBeNull()
  })

  test('getEmails returns emails sorted by received_at DESC', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const e1 = makeEmail({ id: '1', subject: 'First', received_at: '2025-01-01T00:00:00Z' })
    const e2 = makeEmail({ id: '2', subject: 'Second', received_at: '2025-01-02T00:00:00Z' })
    const e3 = makeEmail({ id: '3', subject: 'Third', received_at: '2025-01-03T00:00:00Z' })

    await provider.saveEmail(e1)
    await provider.saveEmail(e2)
    await provider.saveEmail(e3)

    const emails = await provider.getEmails('agent@test.com')
    expect(emails).toHaveLength(3)
    expect(emails[0]!.subject).toBe('Third')
    expect(emails[2]!.subject).toBe('First')
  })

  test('getEmails respects limit and offset', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    for (let i = 0; i < 5; i++) {
      await provider.saveEmail(makeEmail({
        id: `email-${i}`,
        received_at: `2025-01-0${i + 1}T00:00:00Z`,
      }))
    }

    const page1 = await provider.getEmails('agent@test.com', { limit: 2 })
    expect(page1).toHaveLength(2)

    const page2 = await provider.getEmails('agent@test.com', { limit: 2, offset: 2 })
    expect(page2).toHaveLength(2)
    expect(page2[0]!.id).not.toBe(page1[0]!.id)
  })

  test('getEmails filters by direction', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: '1', direction: 'inbound' }))
    await provider.saveEmail(makeEmail({ id: '2', direction: 'outbound', status: 'sent' }))

    const inbound = await provider.getEmails('agent@test.com', { direction: 'inbound' })
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.direction).toBe('inbound')

    const outbound = await provider.getEmails('agent@test.com', { direction: 'outbound' })
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.direction).toBe('outbound')
  })

  test('getEmails filters by mailbox', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({ id: '1', mailbox: 'a@test.com' }))
    await provider.saveEmail(makeEmail({ id: '2', mailbox: 'b@test.com' }))

    const emails = await provider.getEmails('a@test.com')
    expect(emails).toHaveLength(1)
    expect(emails[0]!.mailbox).toBe('a@test.com')
  })

  test('searchEmails matches subject body from and code case-insensitively', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'a',
      subject: 'Reset Password',
      from_name: 'Security Team',
      from_address: 'noreply@service.com',
      body_text: 'Use code 654321 to continue.',
      code: '654321',
    }))
    await provider.saveEmail(makeEmail({
      id: 'b',
      subject: 'Weekly digest',
      from_address: 'digest@example.com',
      body_text: 'Summary for the week',
    }))

    expect((await provider.searchEmails('agent@test.com', { query: 'security' }))[0]!.id).toBe('a')
    expect((await provider.searchEmails('agent@test.com', { query: '654321' }))[0]!.id).toBe('a')
    expect((await provider.searchEmails('agent@test.com', { query: 'DIGEST@EXAMPLE.COM' }))[0]!.id).toBe('b')
  })

  test('searchEmails respects mailbox direction sort and limit', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'same-inbound',
      mailbox: 'agent@test.com',
      direction: 'inbound',
      subject: 'Invoice available',
      received_at: '2025-01-01T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'same-outbound',
      mailbox: 'agent@test.com',
      direction: 'outbound',
      status: 'sent',
      subject: 'Invoice follow-up',
      received_at: '2025-01-03T00:00:00Z',
    }))
    await provider.saveEmail(makeEmail({
      id: 'other-mailbox',
      mailbox: 'other@test.com',
      subject: 'Invoice from another mailbox',
      received_at: '2025-01-04T00:00:00Z',
    }))

    const scoped = await provider.searchEmails('agent@test.com', {
      query: 'invoice',
      direction: 'inbound',
      limit: 5,
    })
    expect(scoped.map(email => email.id)).toEqual(['same-inbound'])

    const ordered = await provider.searchEmails('agent@test.com', { query: 'invoice', limit: 1 })
    expect(ordered).toHaveLength(1)
    expect(ordered[0]!.id).toBe('same-outbound')
  })

  test('getCode returns code when available', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'code-1',
      code: '123456',
      from_address: 'noreply@service.com',
      subject: 'Your code',
    }))

    const result = await provider.getCode('agent@test.com', { timeout: 1 })
    expect(result).not.toBeNull()
    expect(result!.code).toBe('123456')
    expect(result!.from).toBe('noreply@service.com')
    expect(result!.subject).toBe('Your code')
  })

  test('getCode returns null on timeout', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    const result = await provider.getCode('agent@test.com', { timeout: 1 })
    expect(result).toBeNull()
  })

  test('getCode filters by since', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'old',
      code: '111111',
      received_at: '2024-01-01T00:00:00Z',
    }))

    const result = await provider.getCode('agent@test.com', {
      timeout: 1,
      since: '2025-01-01T00:00:00Z',
    })
    expect(result).toBeNull()
  })

  test('saveEmail with JSON headers and metadata', async () => {
    const provider = createSqliteProvider(TEST_DB)
    await provider.init()

    await provider.saveEmail(makeEmail({
      id: 'json-1',
      headers: { 'X-Custom': 'value' },
      metadata: { source: 'test', count: 42 },
    }))

    const email = await provider.getEmail('json-1')
    expect(email!.headers).toEqual({ 'X-Custom': 'value' })
    expect(email!.metadata).toEqual({ source: 'test', count: 42 })
  })
})
