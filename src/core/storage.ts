import type { StorageProvider } from './types.js'
import { loadConfig, resolveApiKey } from './config.js'
import { createSqliteProvider } from '../providers/storage/sqlite.js'
import { createDb9Provider } from '../providers/storage/db9.js'
import { createRemoteProvider } from '../providers/storage/remote.js'

let _provider: StorageProvider | null = null

/** Reset cached provider (for testing only) */
export function _resetStorage(provider?: StorageProvider) { _provider = provider ?? null }

export async function getStorage(): Promise<StorageProvider> {
  if (_provider) return _provider

  const config = loadConfig()

  switch (config.storage_provider) {
    case 'db9': {
      if (!config.db9_token) {
        throw new Error('db9_token not configured. Run: mails config set db9_token <token>')
      }
      if (!config.db9_database_id) {
        throw new Error('db9_database_id not configured. Run: mails config set db9_database_id <id>')
      }
      _provider = createDb9Provider(config.db9_token, config.db9_database_id)
      break
    }
    case 'remote': {
      _provider = await resolveRemoteProvider(config)
      break
    }
    case 'sqlite': {
      _provider = createSqliteProvider()
      break
    }
    default: {
      if (config.api_key || config.worker_url) {
        _provider = await resolveRemoteProvider(config)
      } else {
        _provider = createSqliteProvider()
      }
      break
    }
  }

  await _provider.init()
  return _provider
}

async function resolveRemoteProvider(config: {
  api_key?: string
  worker_url?: string
  worker_token?: string
  mailbox?: string
}): Promise<StorageProvider> {
  const apiUrl = process.env.MAILS_API_URL
    || config.worker_url
    || 'https://mails-dev-worker.o-u-turing.workers.dev'

  let mailbox = config.mailbox || ''

  // Auto-fetch mailbox from API if api_key is set but mailbox is empty
  if (!mailbox && config.api_key) {
    mailbox = await resolveApiKey(config.api_key) ?? ''
  }

  if (!mailbox) {
    throw new Error('mailbox not configured. Run: mails config set mailbox <address>')
  }

  const token = config.api_key || config.worker_token

  return createRemoteProvider({
    url: apiUrl,
    mailbox,
    apiKey: config.api_key,
    token,
  })
}
