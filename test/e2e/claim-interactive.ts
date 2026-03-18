#!/usr/bin/env bun
/**
 * Interactive E2E test: starts local servers and runs `mails claim`.
 *
 * Usage:
 *   bun run test/e2e/claim-interactive.ts [name]
 *
 * This will:
 *   1. Start mails.dev worker on :3160
 *   2. Start mails.dev frontend on :3150
 *   3. Run `mails claim <name>` pointing to local servers
 *   4. Open browser — you log in with Clerk and click Claim
 *   5. CLI receives result, saves to ~/.mails/config.json
 */
import { spawn } from 'bun'
import { join } from 'path'

import { homedir } from 'os'

const name = process.argv[2] || `test${Date.now().toString(36)}`
const MAILS_DEV_DIR = process.env.MAILS_DEV_DIR || join(homedir(), 'Codes', 'mails.dev')
const MAILS_DIR = join(import.meta.dir, '..', '..')

const procs: ReturnType<typeof spawn>[] = []

function cleanup() {
  for (const p of procs) {
    try { p.kill() } catch {}
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('exit', cleanup)

async function waitForServer(url: string, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`)
}

// 1. Start worker
console.log('  Starting worker on :3160 ...')
const worker = spawn({
  cmd: ['npx', 'wrangler', 'dev', '--port', '3160'],
  cwd: join(MAILS_DEV_DIR, 'worker'),
  stdout: 'ignore',
  stderr: 'ignore',
})
procs.push(worker)

// 2. Start frontend
console.log('  Starting frontend on :3150 ...')
const frontend = spawn({
  cmd: ['bun', 'run', 'dev'],
  cwd: MAILS_DEV_DIR,
  stdout: 'ignore',
  stderr: 'ignore',
})
procs.push(frontend)

// 3. Wait for both
await Promise.all([
  waitForServer('http://localhost:3160/health'),
  waitForServer('http://localhost:3150/'),
])
console.log('  Both servers ready.\n')

// 4. Run claim
const claim = spawn({
  cmd: ['bun', 'run', 'src/cli/index.ts', 'claim', name],
  cwd: MAILS_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    MAILS_API_URL: 'http://localhost:3160',
    MAILS_CLAIM_URL: 'http://localhost:3150/claim',
  },
})

const code = await claim.exited
cleanup()
process.exit(code)
