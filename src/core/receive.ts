import type { AttachmentDownload, Email, EmailQueryOptions, EmailSearchOptions } from './types.js'
import { getStorage } from './storage.js'

export async function getInbox(mailbox: string, options?: EmailQueryOptions): Promise<Email[]> {
  const storage = await getStorage()
  return storage.getEmails(mailbox, options)
}

export async function searchInbox(
  mailbox: string,
  options: EmailSearchOptions,
): Promise<Email[]> {
  const storage = await getStorage()
  return storage.searchEmails(mailbox, options)
}

export async function getEmail(id: string): Promise<Email | null> {
  const storage = await getStorage()
  return storage.getEmail(id)
}

export async function downloadAttachment(id: string): Promise<AttachmentDownload | null> {
  const storage = await getStorage()
  if (!storage.getAttachment) {
    throw new Error(`Storage provider "${storage.name}" does not support attachment downloads`)
  }
  return storage.getAttachment(id)
}

export async function waitForCode(mailbox: string, options?: {
  timeout?: number
  since?: string
}): Promise<{ code: string; from: string; subject: string } | null> {
  const storage = await getStorage()
  return storage.getCode(mailbox, options)
}
