import { loadConfig, CONFIG_FILE } from '../../core/config.js'
import { existsSync } from 'node:fs'

export async function doctorCommand() {
  console.log('')
  console.log('  mails doctor')
  console.log('  ────────────')
  let allPassed = true

  // 1. Config file
  const configExists = existsSync(CONFIG_FILE)
  if (configExists) {
    const config = loadConfig()
    const maskedKey = config.api_key ? config.api_key.slice(0, 8) + '...' : '(not set)'
    console.log(`  ✓ Config:   ${CONFIG_FILE}`)
    console.log(`    mailbox:  ${config.mailbox || '(not set)'}`)
    console.log(`    api_key:  ${maskedKey}`)
  } else {
    console.log(`  ✗ Config:   ${CONFIG_FILE} not found`)
    console.log('    Run: mails claim <name>')
    allPassed = false
  }

  // 2. API connectivity + mailbox + send capability via /v1/me
  const config = loadConfig()
  if (config.api_key) {
    const apiUrl = process.env.MAILS_API_URL || config.worker_url || 'https://api.mails0.com'
    try {
      const res = await fetch(`${apiUrl}/v1/me`, {
        headers: { 'Authorization': `Bearer ${config.api_key}` },
      })
      if (res.ok) {
        const data = await res.json() as { mailbox?: string; send?: boolean }
        console.log(`  ✓ API:      ${apiUrl} (connected)`)
        if (data.mailbox) {
          console.log(`  ✓ Mailbox:  ${data.mailbox} (exists)`)
        } else {
          console.log('  ✗ Mailbox:  not found in API response')
          allPassed = false
        }
        if (data.send) {
          console.log('  ✓ Send:     enabled (Resend configured)')
        } else {
          console.log('  ⚠ Send:     not available (no Resend key on server)')
        }
      } else if (res.status === 401) {
        console.log(`  ✗ API:      ${apiUrl} (401 Unauthorized — bad API key?)`)
        allPassed = false
      } else {
        console.log(`  ✗ API:      ${apiUrl} (HTTP ${res.status})`)
        allPassed = false
      }
    } catch (err) {
      console.log(`  ✗ API:      ${apiUrl} (cannot connect)`)
      console.log(`    Error:    ${err instanceof Error ? err.message : err}`)
      allPassed = false
    }
  } else {
    console.log('  ⚠ API:      skipped (no api_key configured)')
    console.log('  ⚠ Mailbox:  skipped')
    console.log('  ⚠ Send:     skipped')
  }

  console.log('')
  if (allPassed) {
    console.log('  All checks passed ✓')
  } else {
    console.log('  Some checks failed. Fix the issues above.')
  }
  console.log('')
}
