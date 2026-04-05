import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('CLI thread and webhook commands', () => {
  test('thread command module exports threadCommand', async () => {
    const mod = await import('../../src/cli/commands/thread')
    expect(typeof mod.threadCommand).toBe('function')
  })

  test('webhook command module exports webhookCommand', async () => {
    const mod = await import('../../src/cli/commands/webhook')
    expect(typeof mod.webhookCommand).toBe('function')
  })

  test('cli index imports thread and webhook commands', () => {
    const indexPath = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts')
    const content = readFileSync(indexPath, 'utf-8')

    expect(content).toContain("import { threadCommand }")
    expect(content).toContain("import { webhookCommand }")
    expect(content).toContain("case 'thread':")
    expect(content).toContain("case 'webhook':")
  })

  test('help command lists thread and webhook', () => {
    const helpPath = join(import.meta.dir, '..', '..', 'src', 'cli', 'commands', 'help.ts')
    const content = readFileSync(helpPath, 'utf-8')

    expect(content).toContain('thread')
    expect(content).toContain('webhook')
    expect(content).toContain('mails thread list')
    expect(content).toContain('mails webhook set')
  })
})
