import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Migration: auth scope', () => {
  test('0003-auth-scope.sql contains ALTER TABLE for scope column', () => {
    const migrationPath = join(import.meta.dir, '..', '..', 'worker', 'migrations', '0003-auth-scope.sql')
    const content = readFileSync(migrationPath, 'utf-8')

    expect(content).toContain('ALTER TABLE auth_tokens ADD COLUMN scope TEXT')
    expect(content).toContain("DEFAULT 'full'")
  })

  test('0003-auth-scope.sql contains ALTER TABLE for status column', () => {
    const migrationPath = join(import.meta.dir, '..', '..', 'worker', 'migrations', '0003-auth-scope.sql')
    const content = readFileSync(migrationPath, 'utf-8')

    expect(content).toContain('ALTER TABLE auth_tokens ADD COLUMN status TEXT')
    expect(content).toContain("DEFAULT 'active'")
  })

  test('0002 migration has uncommented scope ALTER TABLE', () => {
    const migrationPath = join(import.meta.dir, '..', '..', 'worker', 'migrations', '0002-events-domains-webhook-retry.sql')
    const content = readFileSync(migrationPath, 'utf-8')

    // The scope ALTER TABLE should now be uncommented
    const lines = content.split('\n')
    const scopeLine = lines.find(l => l.includes('scope TEXT'))
    expect(scopeLine).toBeDefined()
    expect(scopeLine!.trim().startsWith('--')).toBe(false)
  })

  test('schema.sql includes suppression_list table', () => {
    const schemaPath = join(import.meta.dir, '..', '..', 'worker', 'schema.sql')
    const content = readFileSync(schemaPath, 'utf-8')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS suppression_list')
    expect(content).toContain('email TEXT PRIMARY KEY')
    expect(content).toContain('reason TEXT NOT NULL')
  })

  test('schema.sql includes daily_send_counts table', () => {
    const schemaPath = join(import.meta.dir, '..', '..', 'worker', 'schema.sql')
    const content = readFileSync(schemaPath, 'utf-8')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS daily_send_counts')
    expect(content).toContain('PRIMARY KEY (mailbox, date)')
  })

  test('schema.sql includes domains table', () => {
    const schemaPath = join(import.meta.dir, '..', '..', 'worker', 'schema.sql')
    const content = readFileSync(schemaPath, 'utf-8')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS domains')
    expect(content).toContain('domain TEXT NOT NULL UNIQUE')
  })

  test('schema.sql includes events table', () => {
    const schemaPath = join(import.meta.dir, '..', '..', 'worker', 'schema.sql')
    const content = readFileSync(schemaPath, 'utf-8')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS events')
    expect(content).toContain('event_type TEXT NOT NULL')
  })
})
