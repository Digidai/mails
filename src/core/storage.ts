import type { StorageProvider } from './types.js'
import { loadConfig, resolveApiKey } from './config.js'
import { createSqliteProvider } from '../providers/storage/sqlite.js'
import { createRemoteProvider } from '../providers/storage/remote.js'

let _provider: StorageProvider | null = null
let _providerKey: string | null = null

export async function getStorage(): Promise<StorageProvider> {
  const config = loadConfig()
  const providerKey = getProviderKey(config)

  if (_provider && _providerKey === providerKey) {
    return _provider
  }

  await closeProvider(_provider)

  if (config.api_key || config.worker_url || config.storage_provider === 'remote') {
    _provider = await resolveRemoteProvider(config)
  } else {
    _provider = createSqliteProvider()
  }

  await _provider.init()
  _providerKey = providerKey
  return _provider
}

export async function resetStorage(): Promise<void> {
  await closeProvider(_provider)
  _provider = null
  _providerKey = null
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

async function closeProvider(provider: StorageProvider | null): Promise<void> {
  if (!provider?.close) return
  await provider.close()
}

function getProviderKey(config: {
  api_key?: string
  worker_url?: string
  worker_token?: string
  mailbox?: string
  storage_provider?: string
}): string {
  return JSON.stringify({
    api_key: config.api_key ?? '',
    worker_url: config.worker_url ?? '',
    worker_token: config.worker_token ?? '',
    mailbox: config.mailbox ?? '',
    storage_provider: config.storage_provider ?? '',
    api_url: process.env.MAILS_API_URL ?? '',
  })
}
