import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptStore } from "@/context/prompt"
import type { ServerSDK } from "@/context/server-sdk"
import { createAttachmentUploads } from "./attachment-uploads"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const server = {
  url: "http://localhost:4096",
  server: { http: { type: "http", url: "http://localhost:4096" } },
} as unknown as ServerSDK

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createAttachmentUploads", () => {
  test("uploads pending attachments and stores the completed path", async () => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url.startsWith("blob:")) return new Response(Uint8Array.of(1))
        if (request.method === "POST" && request.url.endsWith("/api/attachment"))
          return Response.json({ attachmentID: "att_1", offset: 0, state: "uploading" })
        if (request.method === "PATCH") return Response.json({ offset: 1 })
        return Response.json({
          path: "/private/file.bin",
          filename: "file.bin",
          mime: "application/octet-stream",
          size: 1,
        })
      },
      { preconnect: originalFetch.preconnect },
    )
    const [store, setStore] = createStore<PromptStore>({
      prompt: [
        {
          type: "image",
          id: "local_1",
          filename: "file.bin",
          mime: "application/octet-stream",
          blob: { id: "blob_1", url: "blob:one" },
          upload: { status: "pending", progress: 0 },
        },
      ],
      context: { items: [] },
    })
    await new Promise<void>((resolve) =>
      createRoot((dispose) => {
        const uploads = createAttachmentUploads({
          prompt: () => ({ current: () => store.prompt, cursor: () => 0, set: (prompt) => setStore("prompt", prompt) }),
          server: () => server,
        })
        const attachment = store.prompt[0]
        if (attachment?.type === "image") uploads.retry(attachment)
        void wait()
          .then(wait)
          .then(() => {
            expect(store.prompt[0]?.type === "image" ? store.prompt[0].upload : undefined).toMatchObject({
              status: "complete",
              attachmentID: "att_1",
              path: "/private/file.bin",
              progress: 1,
            })
            dispose()
            resolve()
          })
      }),
    )
  })

  test("releases a native source only after upload completion", async () => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST" && request.url.endsWith("/api/attachment"))
          return Response.json({ attachmentID: "att_native", offset: 0, state: "uploading" })
        if (request.method === "PATCH") return Response.json({ offset: 1 })
        return Response.json({
          path: "/private/native.bin",
          filename: "native.bin",
          mime: "application/octet-stream",
          size: 1,
        })
      },
      { preconnect: originalFetch.preconnect },
    )
    const source = { token: "token", path: "/local/native.bin", size: 1 }
    const released: typeof source[] = []
    const [store, setStore] = createStore<PromptStore>({
      prompt: [
        {
          type: "image",
          id: "native_1",
          filename: "native.bin",
          mime: "application/octet-stream",
          blob: { id: "native:token", url: "native-file:/local/native.bin", source },
          upload: { status: "pending", progress: 0 },
        },
      ],
      context: { items: [] },
    })
    await new Promise<void>((resolve) =>
      createRoot((dispose) => {
        const uploads = createAttachmentUploads({
          prompt: () => ({ current: () => store.prompt, cursor: () => 0, set: (prompt) => setStore("prompt", prompt) }),
          server: () => server,
          readSource: async () => Uint8Array.of(1).buffer,
          releaseSource: async (value) => {
            released.push(value)
          },
        })
        const attachment = store.prompt[0]
        if (attachment?.type === "image") uploads.retry(attachment)
        void wait()
          .then(wait)
          .then(() => {
            expect(store.prompt[0]?.type === "image" ? store.prompt[0].upload?.status : undefined).toBe("complete")
            expect(released).toEqual([source])
            dispose()
            resolve()
          })
      }),
    )
  })

  test("keeps a native source available when upload fails", async () => {
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST")
          return Response.json({ attachmentID: "att_retry", offset: 0, state: "uploading" })
        throw new Error("network lost")
      },
      { preconnect: originalFetch.preconnect },
    )
    const source = { token: "token", path: "/local/retry.bin", size: 1 }
    const released: typeof source[] = []
    const [store, setStore] = createStore<PromptStore>({
      prompt: [
        {
          type: "image",
          id: "native_retry",
          filename: "retry.bin",
          mime: "application/octet-stream",
          blob: { id: "native:retry", url: "native-file:/local/retry.bin", source },
          upload: { status: "pending", progress: 0 },
        },
      ],
      context: { items: [] },
    })
    await new Promise<void>((resolve) =>
      createRoot((dispose) => {
        const uploads = createAttachmentUploads({
          prompt: () => ({ current: () => store.prompt, cursor: () => 0, set: (prompt) => setStore("prompt", prompt) }),
          server: () => server,
          readSource: async () => Uint8Array.of(1).buffer,
          releaseSource: async (value) => {
            released.push(value)
          },
        })
        const attachment = store.prompt[0]
        if (attachment?.type === "image") uploads.retry(attachment)
        void wait()
          .then(wait)
          .then(() => {
            expect(store.prompt[0]?.type === "image" ? store.prompt[0].upload?.status : undefined).toBe("failed")
            expect(released).toEqual([])
            dispose()
            resolve()
          })
      }),
    )
  })

  test("cancels a native upload by releasing its source and removing its card", async () => {
    const methods: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(new Request(input, init).method)
        return new Response(undefined, { status: 204 })
      },
      { preconnect: originalFetch.preconnect },
    )
    const source = { token: "token", path: "/local/cancel.bin", size: 1 }
    const released: typeof source[] = []
    const [store, setStore] = createStore<PromptStore>({
      prompt: [
        {
          type: "image",
          id: "native_cancel",
          filename: "cancel.bin",
          mime: "application/octet-stream",
          blob: { id: "native:cancel", url: "native-file:/local/cancel.bin", source },
          upload: { status: "failed", progress: 0.5, attachmentID: "att_cancel" },
        },
      ],
      context: { items: [] },
    })
    await new Promise<void>((resolve) =>
      createRoot((dispose) => {
        const uploads = createAttachmentUploads({
          prompt: () => ({ current: () => store.prompt, cursor: () => 0, set: (prompt) => setStore("prompt", prompt) }),
          server: () => server,
          releaseSource: async (value) => {
            released.push(value)
          },
        })
        const attachment = store.prompt[0]
        if (attachment?.type !== "image") return
        void uploads.cancel(attachment).then(() => {
          expect(methods).toEqual(["DELETE"])
          expect(released).toEqual([source])
          expect(store.prompt).toEqual([])
          dispose()
          resolve()
        })
      }),
    )
  })
})
