import { writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { getAttachmentBlobStore } from './blob-store.js'
import { loadConfig } from './config.js'
import { getStorage } from './storage.js'
import type { Attachment } from './types.js'

export async function getAttachment(id: string): Promise<Attachment | null> {
  const config = loadConfig()
  const workerUrl = config.worker_url
  if (workerUrl) {
    const response = await fetch(
      `${workerUrl}/api/attachment?id=${encodeURIComponent(id)}&format=json`,
      {
        headers: buildWorkerHeaders(config.worker_api_key),
      }
    )
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`Failed to get attachment: ${response.status} ${response.statusText}`)
    }
    return await response.json() as Attachment
  }

  const storage = await getStorage()
  return storage.getAttachment(id)
}

export async function downloadAttachment(id: string, outputPath?: string): Promise<string> {
  const config = loadConfig()

  if (config.worker_url) {
    const response = await fetch(`${config.worker_url}/api/attachment?id=${encodeURIComponent(id)}`, {
      headers: buildWorkerHeaders(config.worker_api_key),
    })
    if (response.status === 404) {
      throw new Error(`Attachment not found: ${id}`)
    }
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`)
    }

    const filename = readFilename(response.headers.get('Content-Disposition')) ?? sanitizeFilename(id)
    const targetPath = resolve(outputPath ?? filename)
    await writeFile(targetPath, new Uint8Array(await response.arrayBuffer()))
    return targetPath
  }

  const storage = await getStorage()
  const attachment = await storage.getAttachment(id)
  if (!attachment) {
    throw new Error(`Attachment not found: ${id}`)
  }

  const data = await resolveLocalAttachmentContent(attachment)
  const targetPath = resolve(outputPath ?? basename(attachment.filename))
  await writeFile(targetPath, data)
  return targetPath
}

async function resolveLocalAttachmentContent(attachment: Attachment): Promise<Uint8Array> {
  if (attachment.content_base64) {
    return Uint8Array.from(Buffer.from(attachment.content_base64, 'base64'))
  }

  if (attachment.storage_key) {
    const blobStore = getAttachmentBlobStore()
    const data = await blobStore.get(attachment.storage_key)
    if (data) {
      return data
    }
  }

  throw new Error(`Attachment content is not available for ${attachment.id}`)
}

function readFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null
  const match = contentDisposition.match(/filename="?([^"]+)"?/)
  return match ? sanitizeFilename(match[1]!) : null
}

function sanitizeFilename(value: string): string {
  const filename = basename(value).replace(/[^A-Za-z0-9._-]/g, '_')
  return filename.length > 0 ? filename : 'attachment'
}

function buildWorkerHeaders(apiKey: string | undefined): HeadersInit | undefined {
  if (!apiKey) return undefined
  return {
    'Authorization': `Bearer ${apiKey}`,
  }
}
