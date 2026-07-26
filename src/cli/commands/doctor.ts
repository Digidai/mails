import { loadConfig, CONFIG_FILE } from '../../core/config.js'
import { existsSync } from 'node:fs'
import type { MailsConfig } from '../../core/types.js'
import { clientHeaders } from '../../core/client.js'

interface DoctorOptions {
  configFile?: string
  configExists?: boolean
  loadConfig?: () => MailsConfig
  fetch?: typeof fetch
  apiUrl?: string
  timeoutMs?: number
}

export async function doctorCommand(options: DoctorOptions = {}) {
  const configFile = options.configFile ?? CONFIG_FILE
  const readConfig = options.loadConfig ?? loadConfig
  const fetcher = options.fetch ?? fetch

  console.log('')
  console.log('  mails doctor')
  console.log('  ────────────')
  let allPassed = true

  // 1. Config file
  const configExists = options.configExists ?? existsSync(configFile)
  if (configExists) {
    const config = readConfig()
    const maskedKey = config.api_key ? '[configured]' : '(not set)'
    console.log(`  ✓ Config:   ${configFile}`)
    console.log(`    mailbox:  ${config.mailbox || '(not set)'}`)
    console.log(`    api_key:  ${maskedKey}`)
  } else {
    console.log(`  ✗ Config:   ${configFile} not found`)
    console.log('    Run: mails bootstrap')
    allPassed = false
  }

  // 2. API connectivity + mailbox + send capability via /v1/me
  const config = readConfig()
  if (config.api_key) {
    const apiUrl = options.apiUrl || process.env.MAILS_API_URL || config.worker_url || 'https://api.mails0.com'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000)
    try {
      const res = await fetcher(`${apiUrl}/v1/me`, {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          ...clientHeaders('doctor'),
        },
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json() as {
          mailbox?: string
          send?: boolean
          scope?: string
          expires_at?: string | null
        }
        console.log(`  ✓ API:      ${apiUrl} (connected)`)
        if (data.mailbox) {
          console.log(`  ✓ Mailbox:  ${data.mailbox} (exists)`)
        } else {
          console.log('  ✗ Mailbox:  not found in API response')
          allPassed = false
        }
        if (data.send) {
          console.log('  ✓ Send:     enabled (Resend configured)')
        } else if (data.scope === 'provisional') {
          console.log('  ⚠ Send:     unavailable for provisional mailboxes')
        } else {
          console.log('  ⚠ Send:     not available (no Resend key on server)')
        }
        if (data.scope) console.log(`  ✓ Scope:    ${data.scope}`)
        if (data.expires_at) console.log(`  ⚠ Expires:  ${data.expires_at}`)
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
    } finally {
      clearTimeout(timeout)
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
