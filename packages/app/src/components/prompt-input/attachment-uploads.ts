import { createEffect, onCleanup } from "solid-js"
import type { ImageAttachmentPart, Prompt, usePrompt } from "@/context/prompt"
import type { ServerSDK } from "@/context/server-sdk"
import {
  AttachmentUploadError,
  attachmentServerHeaders,
  cancelPromptAttachment,
  uploadPromptAttachment,
} from "@/utils/attachments"

type PromptTarget = Pick<ReturnType<ReturnType<typeof usePrompt>["capture"]>, "current" | "cursor" | "set">

export function createAttachmentUploads(input: {
  prompt: () => PromptTarget
  server: () => ServerSDK
  readSource?: (
    source: NonNullable<ImageAttachmentPart["blob"]["source"]>,
    offset: number,
    length: number,
  ) => Promise<ArrayBuffer>
  releaseSource?: (source: NonNullable<ImageAttachmentPart["blob"]["source"]>) => Promise<void>
  onError?: (error: unknown) => void
}) {
  const active = new Map<string, AbortController>()

  const update = (id: string, change: Partial<NonNullable<ImageAttachmentPart["upload"]>>) => {
    const prompt = input.prompt()
    prompt.set(
      prompt.current().map((part) => {
        if (part.type !== "image" || part.id !== id) return part
        return { ...part, upload: { status: "pending", progress: 0, ...part.upload, ...change } }
      }),
      prompt.cursor(),
    )
  }

  const start = async (attachment: ImageAttachmentPart) => {
    if (active.has(attachment.id) || attachment.upload?.status === "complete") return
    const controller = new AbortController()
    active.set(attachment.id, controller)
    update(attachment.id, { status: "uploading", error: undefined })
    try {
      const blob = attachment.blob.source
        ? undefined
        : await fetch(attachment.blob.url, { signal: controller.signal }).then((response) => response.blob())
      const result = await uploadPromptAttachment(
        input.server(),
        {
          name: attachment.filename,
          mime: attachment.mime,
          blob,
          source:
            attachment.blob.source && input.readSource
              ? {
                  size: attachment.blob.source.size,
                  read: (offset, length) => input.readSource!(attachment.blob.source!, offset, length),
                }
              : undefined,
          attachmentID: attachment.upload?.attachmentID,
          onAttachmentID: (attachmentID) => update(attachment.id, { attachmentID }),
          onProgress: (progress) => update(attachment.id, { status: "uploading", progress }),
        },
        controller.signal,
      )
      update(attachment.id, { status: "complete", progress: 1, ...result })
      if (attachment.blob.source) await input.releaseSource?.(attachment.blob.source)
    } catch (error) {
      if (controller.signal.aborted) return
      update(attachment.id, {
        status: "failed",
        attachmentID: error instanceof AttachmentUploadError ? error.attachmentID : attachment.upload?.attachmentID,
        error: error instanceof Error ? error.message : String(error),
      })
      input.onError?.(error)
    } finally {
      active.delete(attachment.id)
    }
  }

  const retry = (attachment: ImageAttachmentPart) => {
    update(attachment.id, { status: "pending", error: undefined })
    void start({
      ...attachment,
      upload: { ...attachment.upload, status: "pending", progress: attachment.upload?.progress ?? 0 },
    })
  }

  const discard = (id: string) => {
    const prompt = input.prompt()
    prompt.set(
      prompt.current().filter((part) => part.type !== "image" || part.id !== id),
      prompt.cursor(),
    )
  }

  const cancel = async (attachment: ImageAttachmentPart) => {
    active.get(attachment.id)?.abort()
    active.delete(attachment.id)
    const attachmentID = attachment.upload?.attachmentID
    discard(attachment.id)
    const results = await Promise.allSettled([
      attachmentID ? cancelPromptAttachment(input.server(), attachmentID) : Promise.resolve(),
      attachment.blob.source ? (input.releaseSource?.(attachment.blob.source) ?? Promise.resolve()) : Promise.resolve(),
    ])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) input.onError?.(failure.reason)
  }

  const remove = (attachment: ImageAttachmentPart) => {
    if (attachment.upload?.status !== "complete") {
      void cancel(attachment)
      return
    }
    if (attachment.blob.source) void input.releaseSource?.(attachment.blob.source).catch(() => undefined)
    discard(attachment.id)
  }

  const download = async (attachment: ImageAttachmentPart) => {
    try {
      const attachmentID = attachment.upload?.attachmentID
      if (!attachmentID) return
      const response = await fetch(
        new URL(`/api/attachment/${encodeURIComponent(attachmentID)}/content`, input.server().url),
        {
          headers: attachmentServerHeaders(input.server().server.http),
        },
      )
      if (!response.ok) throw new Error(await response.text())
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement("a")
      link.href = url
      link.download = attachment.upload?.filename ?? attachment.filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      input.onError?.(error)
    }
  }

  createEffect(() => {
    for (const part of input.prompt().current()) {
      if (part.type !== "image") continue
      if (!part.upload || part.upload.status === "pending" || part.upload.status === "uploading") void start(part)
    }
  })

  onCleanup(() => {
    for (const controller of active.values()) controller.abort()
    active.clear()
  })

  return { retry, cancel, remove, download }
}
