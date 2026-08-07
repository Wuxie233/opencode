import { afterEach, describe, expect, test } from "bun:test"
import { AttachmentUploadError, cancelPromptAttachment, uploadPromptAttachment } from "./attachments"
import type { ServerSDK } from "@/context/server-sdk"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const server = {
  url: "http://localhost:4096",
  server: { http: { type: "http", url: "http://localhost:4096" } },
} as unknown as ServerSDK

describe("uploadPromptAttachment", () => {
  test("uploads chunks and completes with the attachment ID", async () => {
    const requests: Request[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.method === "POST" && request.url.endsWith("/api/attachment"))
          return Response.json({ attachmentID: "att_1", offset: 0, state: "uploading" })
        if (request.method === "PATCH")
          return Response.json({
            offset: Number(request.headers.get("upload-offset")) + (await request.arrayBuffer()).byteLength,
          })
        return Response.json({
          path: "/files/data.bin",
          filename: "data.bin",
          mime: "application/octet-stream",
          size: 3,
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    const progress: number[] = []
    const ids: string[] = []
    const result = await uploadPromptAttachment(server, {
      name: "data.bin",
      mime: "application/octet-stream",
      blob: new Blob([Uint8Array.of(1, 2, 3)]),
      onAttachmentID: (attachmentID) => ids.push(attachmentID),
      onProgress: (value) => progress.push(value),
    })

    expect(result).toEqual({
      attachmentID: "att_1",
      path: "/files/data.bin",
      filename: "data.bin",
      mime: "application/octet-stream",
      size: 3,
    })
    expect(requests.map((request) => request.method)).toEqual(["POST", "PATCH", "POST"])
    expect(ids).toEqual(["att_1"])
    expect(progress.at(-1)).toBe(1)
  })

  test("resumes from status and accepts the server offset after a conflict", async () => {
    const offsets: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "GET")
          return Response.json({ attachmentID: "att_resume", offset: 1, state: "uploading" })
        if (request.method === "PATCH") {
          offsets.push(request.headers.get("upload-offset") ?? "")
          if (offsets.length === 1)
            return Response.json({ _tag: "AttachmentConflictError", offset: 2 }, { status: 409 })
          return Response.json({ offset: 4 })
        }
        return Response.json({
          path: "/files/data.bin",
          filename: "data.bin",
          mime: "application/octet-stream",
          size: 4,
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    await uploadPromptAttachment(server, {
      name: "data.bin",
      mime: "application/octet-stream",
      blob: new Blob([Uint8Array.of(1, 2, 3, 4)]),
      attachmentID: "att_resume",
    })
    expect(offsets).toEqual(["1", "2"])
  })

  test("streams files larger than one chunk", async () => {
    const sizes: number[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST" && request.url.endsWith("/api/attachment"))
          return Response.json({ attachmentID: "att_large", offset: 0, state: "uploading" })
        if (request.method === "PATCH") {
          const offset = Number(request.headers.get("upload-offset"))
          const size = (await request.arrayBuffer()).byteLength
          sizes.push(size)
          return Response.json({ offset: offset + size })
        }
        return Response.json({
          path: "/files/large.bin",
          filename: "large.bin",
          mime: "application/octet-stream",
          size: 1_048_577,
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    await uploadPromptAttachment(server, {
      name: "large.bin",
      mime: "application/octet-stream",
      blob: new Blob([new Uint8Array(1_048_577)]),
    })
    expect(sizes).toEqual([1_048_576, 1])
  })

  test("streams a native source without materializing a Blob", async () => {
    const reads: Array<[number, number]> = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST" && request.url.endsWith("/api/attachment"))
          return Response.json({ attachmentID: "att_native", offset: 0, state: "uploading" })
        if (request.method === "PATCH") {
          const offset = Number(request.headers.get("upload-offset"))
          return Response.json({ offset: offset + (await request.arrayBuffer()).byteLength })
        }
        return Response.json({
          path: "/files/native.bin",
          filename: "native.bin",
          mime: "application/octet-stream",
          size: 1_048_577,
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    await uploadPromptAttachment(server, {
      name: "native.bin",
      mime: "application/octet-stream",
      source: {
        size: 1_048_577,
        read: async (offset, length) => {
          reads.push([offset, length])
          return new ArrayBuffer(length)
        },
      },
    })
    expect(reads).toEqual([
      [0, 1_048_576],
      [1_048_576, 1],
    ])
  })

  test("keeps the resumable ID when a chunk fails", async () => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST")
          return Response.json({ attachmentID: "att_failed", offset: 0, state: "uploading" })
        throw new Error("network lost")
      },
      { preconnect: originalFetch.preconnect },
    )

    const error = await uploadPromptAttachment(server, {
      name: "data.bin",
      mime: "application/octet-stream",
      blob: new Blob([Uint8Array.of(1)]),
    }).catch((cause) => cause)
    expect(error).toBeInstanceOf(AttachmentUploadError)
    expect(error.attachmentID).toBe("att_failed")
  })

  test("resumes a chunk after a transient network failure", async () => {
    const methods: string[] = []
    const offsets: string[] = []
    let patchAttempts = 0
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        methods.push(request.method)
        if (request.method === "POST" && request.url.endsWith("/api/attachment"))
          return Response.json({ attachmentID: "att_retryable", offset: 0, state: "uploading" })
        if (request.method === "PATCH") {
          offsets.push(request.headers.get("upload-offset") ?? "")
          patchAttempts += 1
          if (patchAttempts === 1) throw new TypeError("Failed to fetch")
          return Response.json({ offset: (await request.arrayBuffer()).byteLength })
        }
        if (request.method === "GET")
          return Response.json({ attachmentID: "att_retryable", offset: 0, state: "uploading" })
        return Response.json({
          path: "/files/retryable.bin",
          filename: "retryable.bin",
          mime: "application/octet-stream",
          size: 1,
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    await uploadPromptAttachment(server, {
      name: "retryable.bin",
      mime: "application/octet-stream",
      blob: new Blob([Uint8Array.of(1)]),
    })

    expect(methods).toEqual(["POST", "PATCH", "PATCH", "POST"])
    expect(offsets).toEqual(["0", "0"])
  })

  test("does not create duplicate attachments when initialization fails", async () => {
    let creates = 0
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST" && request.url.endsWith("/api/attachment")) {
          creates += 1
          throw new TypeError("Failed to fetch")
        }
        return Response.json({})
      },
      { preconnect: originalFetch.preconnect },
    )

    const error = await uploadPromptAttachment(server, {
      name: "lost-init.bin",
      mime: "application/octet-stream",
      blob: new Blob([Uint8Array.of(1)]),
    }).catch((cause) => cause)

    expect(error).toBeInstanceOf(AttachmentUploadError)
    expect(creates).toBe(1)
  })

  test("cancels an unfinished upload", async () => {
    const methods: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(new Request(input, init).method)
        return new Response(undefined, { status: 204 })
      },
      { preconnect: originalFetch.preconnect },
    )
    await cancelPromptAttachment(server, "att_cancel")
    expect(methods).toEqual(["DELETE"])
  })
})
