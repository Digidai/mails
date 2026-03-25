export { send } from './core/send.js'
export { getInbox, searchInbox, getEmail, deleteEmail, waitForCode } from './core/receive.js'
export { getStorage, resetStorage } from './core/storage.js'
export { loadConfig, saveConfig, getConfigValue, setConfigValue } from './core/config.js'
export { createResendProvider } from './providers/send/resend.js'
export { createHostedSendProvider } from './providers/send/hosted.js'
export { createWorkerSendProvider } from './providers/send/worker.js'
export { createSqliteProvider } from './providers/storage/sqlite.js'
export { createRemoteProvider } from './providers/storage/remote.js'

export type {
  Attachment,
  AttachmentTextExtractionStatus,
  Email,
  PreparedAttachment,
  SendAttachment,
  SendOptions,
  SendResult,
  SendProvider,
  StorageProvider,
  EmailQueryOptions,
  EmailSearchOptions,
  MailsConfig,
} from './core/types.js'
