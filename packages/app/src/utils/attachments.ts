import type { ServerConnection } from "@/context/server"
import type { ServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "./server"

type UploadResult = { path: string; filename: string; mime: string; size: number }
type UploadInfo = { attachmentID: string; offset: number; state: "uploading" | "complete" | "cancelled" }

export class AttachmentUploadError extends Error {
  constructor(
    message: string,
    readonly attachmentID?: string,
  ) {
    super(message)
  }
}

type UploadInput = {
  name: string
  mime: string
  blob?: Blob
  source?: { size: number; read(offset: number, length: number): Promise<ArrayBuffer> }
  attachmentID?: string
  onAttachmentID?: (attachmentID: string) => void
  onProgress?: (progress: number) => void
}

export async function uploadPromptAttachment(server: ServerSDK, input: UploadInput, signal?: AbortSignal) {
  const headers = attachmentServerHeaders(server.server.http)
  const size = input.source?.size ?? input.blob?.size
  if (size === undefined) throw new AttachmentUploadError("Attachment has no readable source", input.attachmentID)
  let attachmentID = input.attachmentID
  try {
    const create = () =>
      fetch(new URL("/api/attachment", server.url), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" } as Record<string, string>,
        body: JSON.stringify({ name: input.name, mime: input.mime, size }),
        signal,
      })
    const status = input.attachmentID
      ? await retryFetch(
          () =>
            fetch(new URL(`/api/attachment/${encodeURIComponent(input.attachmentID!)}`, server.url), {
              headers,
              signal,
            }),
          signal,
        )
      : undefined
    const response = await (status?.status === 404 ? create() : (status ?? create()))
    const init = await readJson<UploadInfo>(response)
    const current = init.state === "cancelled" ? await create().then(readJson<UploadInfo>) : init
    attachmentID = current.attachmentID
    input.onAttachmentID?.(current.attachmentID)
    if (current.state === "complete") {
      const result = await retryFetch(
        () =>
          fetch(new URL(`/api/attachment/${encodeURIComponent(current.attachmentID)}/complete`, server.url), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" } as Record<string, string>,
            signal,
          }),
        signal,
      ).then(readJson<UploadResult>)
      return { attachmentID: current.attachmentID, ...result }
    }
    const chunkSize = 1024 * 1024
    let offset = current.offset
    if (offset > size) throw new Error(`Upload offset ${offset} exceeds local file size ${size}`)
    input.onProgress?.(size === 0 ? 1 : offset / size)
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset)
      const chunk = input.source
        ? await input.source.read(offset, length)
        : await input.blob!.slice(offset, offset + length).arrayBuffer()
      if (chunk.byteLength === 0 && length > 0)
        throw new Error(`Attachment source returned no data at offset ${offset}`)
      const response = await retryFetch(
        () =>
          fetch(new URL(`/api/attachment/${encodeURIComponent(current.attachmentID)}`, server.url), {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/octet-stream", "upload-offset": String(offset) } as Record<
              string,
              string
            >,
            body: chunk,
            signal,
          }),
        signal,
      )
      if (response.status === 409) {
        const conflict = await response.json()
        const next = conflict && typeof conflict === "object" && "offset" in conflict ? conflict.offset : undefined
        if (typeof next !== "number" || next === offset || next < 0 || next > size)
          throw new Error("Upload offset conflict")
        offset = next
        continue
      }
      offset = (await readJson<{ offset: number }>(response)).offset
      input.onProgress?.(size === 0 ? 1 : offset / size)
    }

    const result = await retryFetch(
      () =>
        fetch(new URL(`/api/attachment/${encodeURIComponent(current.attachmentID)}/complete`, server.url), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" } as Record<string, string>,
          signal,
        }),
      signal,
    ).then(readJson<UploadResult>)
    return { attachmentID: current.attachmentID, ...result }
  } catch (error) {
    if (error instanceof AttachmentUploadError) throw error
    throw new AttachmentUploadError(error instanceof Error ? error.message : String(error), attachmentID)
  }
}

export async function cancelPromptAttachment(server: ServerSDK, attachmentID: string) {
  const response = await fetch(new URL(`/api/attachment/${encodeURIComponent(attachmentID)}`, server.url), {
    method: "DELETE",
    headers: attachmentServerHeaders(server.server.http),
  })
  if (!response.ok && response.status !== 404 && response.status !== 409) throw new Error(await response.text())
}

export function attachmentServerHeaders(server: ServerConnection.HttpBase): Record<string, string> {
  if (!server.password) return {}
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

async function readJson<T>(response: Response) {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as T
}

async function retryFetch(request: () => Promise<Response>, signal?: AbortSignal) {
  const delays = [100, 300]
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await request()
      if (!retryable(response.status) || attempt === delays.length) return response
    } catch (error) {
      if (signal?.aborted || attempt === delays.length) throw error
    }
    await wait(delays[attempt], signal)
  }
}

function retryable(status: number) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
}

function wait(delay: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(done, delay)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener("abort", abort, { once: true })
  })
}
