import { updateConfig } from '../../core/config.js'
import { clientHeaders } from '../../core/client.js'

const API_BASE = process.env.MAILS_CLAIM_URL || 'https://mails0.com'
const CLAIM_PAGE = process.env.MAILS_CLAIM_PAGE || process.env.MAILS_CLAIM_URL || 'https://mails0.com'
const POLL_INTERVAL = 2000

export async function claimCommand(args: string[]) {
  const name = args[0]

  if (!name) {
    console.error('Usage: mails claim <name>')
    console.error('Example: mails claim myagent  →  myagent@mails0.com')
    process.exit(1)
  }

  // 1. Create claim session
  let startRes: Response
  try {
    startRes = await fetch(`${API_BASE}/v1/claim/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...clientHeaders('human-claim'),
      },
      body: JSON.stringify({ name }),
    })
  } catch (err) {
    console.error(`Cannot connect to ${API_BASE}: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const startData = await startRes.json() as {
    session_id?: string
    device_code?: string
    error?: string
  }

  if (!startRes.ok) {
    console.error(`Error: ${startData.error}`)
    process.exit(1)
  }

  const { session_id, device_code } = startData
  const claimUrl = `${CLAIM_PAGE}?session=${session_id}&claim=${encodeURIComponent(name)}&source=cli`

  // 2. Try to open browser
  let browserOpened = false
  try {
    const { execSync } = await import('child_process')
    const platform = process.platform
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
    execSync(`${cmd} "${claimUrl}"`, { stdio: 'ignore', timeout: 3000 })
    browserOpened = true
  } catch {}

  // 3. Show info
  console.log('')
  if (browserOpened) {
    console.log(`  Claiming ${name}@mails0.com — confirm in your browser.`)
    console.log('')
    console.log(`  If the page didn't open: ${claimUrl}`)
  } else {
    // No browser (sandbox / SSH / headless)
    console.log(`  Claiming ${name}@mails0.com`)
    console.log('')
    console.log(`  Open this link to confirm:`)
    console.log('')
    console.log(`    ${claimUrl}`)
  }
  console.log('')

  // 4. Poll for result
  process.stdout.write('  Waiting...')

  const deadline = Date.now() + 10 * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))

    let pollRes: Response
    try {
      pollRes = await fetch(`${API_BASE}/v1/claim/poll?session=${session_id}`, {
        headers: clientHeaders('human-claim'),
      })
    } catch {
      // Network error during poll — retry silently
      continue
    }
    const pollData = await pollRes.json() as {
      status: string
      mailbox?: string
      api_key?: string
    }

    if (pollData.status === 'complete') {
      process.stdout.write('\n')
      console.log('')

      updateConfig({
        mode: 'hosted',
        domain: 'mails0.com',
        mailbox: pollData.mailbox!,
        api_key: pollData.api_key!,
        default_from: pollData.mailbox!,
        worker_url: 'https://api.mails0.com',
        storage_provider: 'remote',
        token_scope: 'mailbox',
        token_expires_at: undefined,
        bootstrap_idempotency_key: undefined,
      })

      console.log(`  ✓ Claimed: ${pollData.mailbox}`)
      console.log('  ✓ API key saved securely (not printed)')
      console.log(`  ✓ Saved to ~/.mails/config.json`)
      console.log('')
      console.log('  Try it now:')
      console.log(`    mails inbox`)
      console.log(`    mails code --to ${pollData.mailbox} --timeout 30`)
      console.log('    # Outbound sending unlocks after the new-mailbox warm-up period.')
      console.log('')
      console.log('  Docs: https://github.com/Digidai/mails')
      return
    }

    if (pollData.status === 'expired') {
      process.stdout.write('\n')
      console.error('  Session expired. Try again.')
      process.exit(1)
    }

    process.stdout.write('.')
  }

  process.stdout.write('\n')
  console.error('  Timeout. Try again.')
  process.exit(1)
}
