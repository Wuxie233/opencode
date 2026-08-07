import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { nativeT } from "./native-translations"

export const MAX_ATTACHMENT_CHUNK_BYTES = 1024 * 1024

export function createPickedFileAuthorizations(
  read: (path: string, offset: number, length: number) => Promise<ArrayBuffer> = readAttachment,
) {
  const selections = new Map<string, { sender: number; files: Map<string, number> }>()

  return {
    add(sender: number, files: { path: string; size: number }[]) {
      const token = randomUUID()
      selections.set(token, { sender, files: new Map(files.map((file) => [file.path, file.size])) })
      return token
    },
    async read(sender: number, token: string, path: string, offset: number, length: number) {
      const selection = selections.get(token)
      const size = selection?.files.get(path)
      if (selection?.sender !== sender || size === undefined)
        throw new Error(nativeT("desktop.picker.error.notSelected"))
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size)
        throw new Error(nativeT("desktop.picker.error.notSelected"))
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ATTACHMENT_CHUNK_BYTES)
        throw new Error(nativeT("desktop.picker.error.sizeLimit", { limit: 1 }))
      const bytes = await read(path, offset, Math.min(length, size - offset))
      return bytes
    },
    release(sender: number, token: string, path?: string) {
      const selection = selections.get(token)
      if (selection?.sender !== sender) return
      if (!path) return selections.delete(token)
      selection.files.delete(path)
      if (selection.files.size === 0) selections.delete(token)
    },
    releaseSender(sender: number) {
      for (const [token, selection] of selections) {
        if (selection.sender === sender) selections.delete(token)
      }
    },
  }
}

export function assertAttachmentBudget(files: { size: number }[]) {
  if (files.every((file) => file.size >= 0 && Number.isFinite(file.size))) return
  throw new Error(nativeT("desktop.picker.error.sizeLimit", { limit: "available storage" }))
}

export async function readAttachment(filePath: string, offset = 0, length = MAX_ATTACHMENT_CHUNK_BYTES) {
  const file = await open(filePath, "r")
  try {
    const info = await file.stat()
    const bytes = Buffer.allocUnsafe(Math.min(length, Math.max(0, info.size - offset)))
    const result = await file.read(bytes, 0, bytes.byteLength, offset)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + result.bytesRead) as ArrayBuffer
  } finally {
    await file.close()
  }
}
