export { send } from './core/send.js'
export { getInbox, searchInbox, getEmail, waitForCode } from './core/receive.js'
export { getStorage } from './core/storage.js'
export { loadConfig, saveConfig, getConfigValue, setConfigValue } from './core/config.js'
export { createResendProvider } from './providers/send/resend.js'
export { createSqliteProvider } from './providers/storage/sqlite.js'
export { createDb9Provider } from './providers/storage/db9.js'

export type {
  Email,
  SendOptions,
  SendResult,
  SendProvider,
  StorageProvider,
  EmailQueryOptions,
  EmailSearchOptions,
  MailsConfig,
} from './core/types.js'
