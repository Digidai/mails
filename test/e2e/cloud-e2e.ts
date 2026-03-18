#!/usr/bin/env bun
/**
 * E2E test runner for tests that depend on the mails.dev cloud worker.
 *
 * Automatically starts the mails.dev worker, runs tests, then cleans up.
 *
 * Requires:
 *   - ~/Codes/mails.dev/worker exists with dependencies installed
 *   - D1 schema + migrations applied locally
 *
 * Usage:
 *   bun run test/e2e/cloud-e2e.ts
 */
import { spawn, type Subprocess } from 'bun'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

const MAILS_DEV_WORKER = join(homedir(), 'Codes', 'mails.dev', 'worker')
const PORT = 3160
const API = `http://localhost:${PORT}`

let worker: Subprocess | null = null

async function waitForServer(url: string, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`)
}

async function setup() {
  // Ensure deps
  console.log('Installing mails.dev worker dependencies...')
  execSync('bun install', { cwd: MAILS_DEV_WORKER, stdio: 'pipe' })

  // Apply schema + migrations
  console.log('Applying D1 schema...')
  try {
    execSync('npx wrangler d1 execute mails-dev --local --file=schema.sql', { cwd: MAILS_DEV_WORKER, stdio: 'pipe' })
  } catch {}
  try {
    execSync('npx wrangler d1 execute mails-dev --local --file=migrations/001_users_mailboxes.sql', { cwd: MAILS_DEV_WORKER, stdio: 'pipe' })
  } catch {}
  try {
    execSync('npx wrangler d1 execute mails-dev --local --file=migrations/002_auth_sessions_columns.sql', { cwd: MAILS_DEV_WORKER, stdio: 'pipe' })
  } catch {}

  // Kill any existing process on the port
  try {
    execSync(`lsof -ti :${PORT} | xargs kill`, { stdio: 'pipe' })
    await new Promise(r => setTimeout(r, 500))
  } catch {}

  // Start worker
  console.log(`Starting mails.dev worker on :${PORT}...`)
  worker = spawn({
    cmd: ['npx', 'wrangler', 'dev', '--port', String(PORT)],
    cwd: MAILS_DEV_WORKER,
    stdout: 'ignore',
    stderr: 'ignore',
  })

  await waitForServer(`${API}/health`)
  console.log('Worker ready.\n')
}

function cleanup() {
  if (worker) {
    worker.kill()
    worker = null
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('exit', cleanup)

// Main
await setup()

const testFiles = [
  'test/e2e/claim-flow.test.ts',
]

console.log(`Running ${testFiles.length} test file(s) against mails.dev worker...\n`)

const testProc = spawn({
  cmd: ['bun', 'test', ...testFiles],
  cwd: join(import.meta.dir, '../..'),
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    MAILS_API_URL: API,
    MAILS_CLAIM_URL: `http://localhost:3150`,
  },
})

const code = await testProc.exited
cleanup()
process.exit(code)
