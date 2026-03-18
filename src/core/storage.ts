import type { StorageProvider } from './types.js'
import { loadConfig } from './config.js'
import { createSqliteProvider } from '../providers/storage/sqlite.js'
import { createDb9Provider } from '../providers/storage/db9.js'
import { createRemoteProvider } from '../providers/storage/remote.js'

let _provider: StorageProvider | null = null

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
      _provider = resolveRemoteProvider(config)
      break
    }
    case 'sqlite': {
      _provider = createSqliteProvider()
      break
    }
    default: {
      // Auto-detect:
      // 1. api_key set → hosted mode, use remote with /v1/* auth endpoints
      // 2. worker_url set → self-hosted, use remote with /api/* public endpoints
      // 3. Otherwise → local sqlite
      if (config.api_key || config.worker_url) {
        _provider = resolveRemoteProvider(config)
      } else {
        _provider = createSqliteProvider()
      }
      break
    }
  }

  await _provider.init()
  return _provider
}

function resolveRemoteProvider(config: {
  api_key?: string
  worker_url?: string
  mailbox?: string
}): StorageProvider {
  const apiUrl = process.env.MAILS_API_URL
    || config.worker_url
    || 'https://mails-dev-worker.o-u-turing.workers.dev'

  const mailbox = config.mailbox || ''
  if (!mailbox) {
    throw new Error('mailbox not configured. Run: mails config set mailbox <address>')
  }

  return createRemoteProvider({
    url: apiUrl,
    mailbox,
    apiKey: config.api_key,
  })
}
