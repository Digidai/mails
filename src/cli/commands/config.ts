import { loadConfig, getConfigValue, setConfigValue, resolveApiKey, CONFIG_FILE } from '../../core/config.js'

const SENSITIVE_KEYS = new Set([
  'api_key',
  'worker_token',
  'bootstrap_idempotency_key',
])

export async function configCommand(args: string[]) {
  const subcommand = args[0]

  switch (subcommand) {
    case 'set': {
      const key = args[1]
      const value = args[2]
      if (!key || !value) {
        console.error('Usage: mails config set <key> <value>')
        process.exit(1)
      }
      setConfigValue(key, value)
      console.log(SENSITIVE_KEYS.has(key) ? `Set ${key} = [redacted]` : `Set ${key} = ${value}`)

      // When api_key is set, auto-resolve mailbox from /v1/me
      if (key === 'api_key' && value.startsWith('mk_')) {
        const mailbox = await resolveApiKey(value)
        if (mailbox) {
          console.log(`Resolved mailbox: ${mailbox}`)
          console.log(`Set default_from = ${mailbox}`)
        }
      }
      break
    }

    case 'get': {
      const key = args[1]
      if (!key) {
        console.error('Usage: mails config get <key>')
        process.exit(1)
      }
      const value = getConfigValue(key)
      if (value !== undefined) {
        console.log(value)
      } else {
        console.error(`Key "${key}" not set`)
        process.exit(1)
      }
      break
    }

    case 'path': {
      console.log(CONFIG_FILE)
      break
    }

    default: {
      const config = loadConfig()
      const display = Object.fromEntries(
        Object.entries(config).map(([key, value]) => [
          key,
          SENSITIVE_KEYS.has(key) && value ? '[configured]' : value,
        ]),
      )
      console.log(JSON.stringify(display, null, 2))
      break
    }
  }
}
