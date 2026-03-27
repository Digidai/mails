/**
 * E2E test for the claim CLI polling flow.
 *
 * Requires mails0.com worker running locally.
 * Use `bun run test/e2e/cloud-e2e.ts` to start the worker automatically.
 * Or manually: cd ~/Codes/mails-web/worker && npx wrangler dev --port 3160
 *
 * Run: bun test test/e2e/claim-flow.test.ts
 */
import { describe, expect, test, afterEach } from 'bun:test'
import { spawn } from 'bun'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

const API = process.env.MAILS_API_URL || 'http://localhost:3160'
const CONFIG_FILE = join(homedir(), '.mails', 'config.json')
const WORKER_DIR = process.env.MAILS_DEV_WORKER_DIR || join(homedir(), 'Codes', 'mails-web', 'worker')

function d1(sql: string) {
  execSync(`cd ${WORKER_DIR} && npx wrangler d1 execute mails-dev --local --command "${sql.replace(/"/g, '\\"')}"`, { stdio: 'pipe' })
}

describe('E2E: claim polling flow', () => {
  const cleanupIds: { sessions: string[]; mailboxes: string[]; users: string[]; emails: string[] } = {
    sessions: [], mailboxes: [], users: [], emails: [],
  }

  afterEach(() => {
    // Clean up D1 data
    for (const id of cleanupIds.emails) d1(`DELETE FROM emails WHERE id = '${id}'`)
    for (const addr of cleanupIds.mailboxes) d1(`DELETE FROM mailboxes WHERE address = '${addr}'`)
    for (const id of cleanupIds.users) d1(`DELETE FROM users WHERE id = '${id}'`)
    for (const id of cleanupIds.sessions) d1(`DELETE FROM auth_sessions WHERE id = '${id}'`)
    cleanupIds.sessions = []; cleanupIds.mailboxes = []; cleanupIds.users = []; cleanupIds.emails = []

    // Reset config
    if (existsSync(CONFIG_FILE)) {
      try {
        const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
        delete config.mailbox
        delete config.api_key
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
      } catch {}
    }
  })

  test('full flow: start → poll pending → confirm → poll complete', async () => {
    const name = `e2e${Date.now()}`

    // 1. Start session
    const startRes = await fetch(`${API}/v1/claim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    expect(startRes.status).toBe(201)
    const start = await startRes.json() as any
    expect(start.session_id).toBeTruthy()
    expect(start.device_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(start.name).toBe(name)
    cleanupIds.sessions.push(start.session_id)
    console.log(`  Session: ${start.session_id.slice(0, 8)}... Code: ${start.device_code}`)

    // 2. Poll → pending
    const poll1 = await fetch(`${API}/v1/claim/poll?session=${start.session_id}`)
    const poll1Data = await poll1.json() as any
    expect(poll1Data.status).toBe('pending')

    // 3. Simulate browser confirm (write directly to D1)
    const fullAddress = `${name}@mails0.com`
    const apiKey = `mk_e2e_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const userId = `test_${crypto.randomUUID()}`
    const now = new Date().toISOString()

    d1(`INSERT OR IGNORE INTO users (id, github_id, github_login, token, created_at) VALUES ('${userId}', 0, 'e2e', 'ut_e2e', '${now}')`)
    d1(`INSERT INTO mailboxes (address, user_id, api_key, sends_today, sends_reset_at, created_at) VALUES ('${fullAddress}', '${userId}', '${apiKey}', 0, '${now}', '${now}')`)
    d1(`UPDATE auth_sessions SET token = '${fullAddress}:${apiKey}', user_id = '${userId}' WHERE id = '${start.session_id}'`)
    cleanupIds.users.push(userId)
    cleanupIds.mailboxes.push(fullAddress)

    // 4. Poll → complete
    const poll2 = await fetch(`${API}/v1/claim/poll?session=${start.session_id}`)
    const poll2Data = await poll2.json() as any
    expect(poll2Data.status).toBe('complete')
    expect(poll2Data.mailbox).toBe(fullAddress)
    expect(poll2Data.api_key).toBe(apiKey)
    console.log(`  Claimed: ${poll2Data.mailbox}`)

    // 5. Session cleaned up
    const poll3 = await fetch(`${API}/v1/claim/poll?session=${start.session_id}`)
    expect(poll3.status).toBe(404)

    // 6. API key works
    const inboxRes = await fetch(`${API}/v1/inbox`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(inboxRes.status).toBe(200)
    const inbox = await inboxRes.json() as any
    expect(inbox.emails).toEqual([])
    console.log('  API key auth works')
  })

  test('CLI claim command polls and receives result', async () => {
    const name = `cli${Date.now()}`

    // Start CLI process pointing to local API
    const proc = spawn({
      cmd: ['bun', 'run', 'src/cli/index.ts', 'claim', name],
      cwd: join(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BROWSER: 'echo', MAILS_API_URL: API, MAILS_CLAIM_URL: 'http://localhost:3150/claim' },
    })

    // Read stdout until we see the device code
    const reader = proc.stdout.getReader()
    let output = ''
    const decoder = new TextDecoder()
    const deadline = Date.now() + 15000
    let sessionId: string | null = null
    let deviceCode: string | null = null

    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      output += decoder.decode(value)

      const sessionMatch = output.match(/session=([a-f0-9-]+)/)
      const codeMatch = output.match(/Code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/)
      if (sessionMatch && codeMatch) {
        sessionId = sessionMatch[1]!
        deviceCode = codeMatch[1]!
        break
      }
    }

    expect(sessionId).not.toBeNull()
    expect(deviceCode).not.toBeNull()
    console.log(`  CLI session: ${sessionId!.slice(0, 8)}... code: ${deviceCode}`)
    cleanupIds.sessions.push(sessionId!)

    // Simulate browser confirm via D1
    const fullAddress = `${name}@mails0.com`
    const apiKey = `mk_cli_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const userId = `test_cli_${crypto.randomUUID()}`
    const now = new Date().toISOString()

    d1(`INSERT OR IGNORE INTO users (id, github_id, github_login, token, created_at) VALUES ('${userId}', 0, 'cli', 'ut_cli', '${now}')`)
    d1(`INSERT INTO mailboxes (address, user_id, api_key, sends_today, sends_reset_at, created_at) VALUES ('${fullAddress}', '${userId}', '${apiKey}', 0, '${now}', '${now}')`)
    d1(`UPDATE auth_sessions SET token = '${fullAddress}:${apiKey}', user_id = '${userId}' WHERE id = '${sessionId}'`)
    cleanupIds.users.push(userId)
    cleanupIds.mailboxes.push(fullAddress)

    // Wait for CLI to pick up the result
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)

    // Read remaining output
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value)
      }
    } catch {}

    expect(output).toContain(fullAddress)
    expect(output).toContain(apiKey)
    expect(output).toContain('Saved to ~/.mails/config.json')
    console.log(`  CLI received: ${fullAddress}`)

    // Verify config
    const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    expect(config.mailbox).toBe(fullAddress)
    expect(config.api_key).toBe(apiKey)
    expect(config.default_from).toBe(fullAddress)
    console.log('  Config saved correctly')
  }, 30000)

  test('start rejects reserved names', async () => {
    const res = await fetch(`${API}/v1/claim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'admin' }),
    })
    expect(res.status).toBe(400)
  })

  test('start rejects invalid names', async () => {
    const res = await fetch(`${API}/v1/claim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    })
    expect(res.status).toBe(400)
  })

  test('confirm requires auth', async () => {
    const res = await fetch(`${API}/v1/claim/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'fake' }),
    })
    expect(res.status).toBe(401)
  })

  test('poll unknown session returns 404', async () => {
    const res = await fetch(`${API}/v1/claim/poll?session=nonexistent`)
    expect(res.status).toBe(404)
  })

  test('CLI shows usage without args', async () => {
    const proc = spawn({
      cmd: ['bun', 'run', 'src/cli/index.ts', 'claim'],
      cwd: join(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('Usage: mails claim <name>')
  })
})
