import { getFilename } from "@opencode-ai/core/util/path"
import { type AgentPartInput, type FilePartInput, type Part, type TextPartInput } from "@opencode-ai/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { visualAttachmentMime } from "@/constants/file-picker"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: (Omit<ImageAttachmentPart, "blob"> & { dataUrl: string })[]
  text: string
  messageID: string
  sessionID: string
  sessionDirectory: string
  uploadedFiles?: { id?: string; path: string; filename: string; mime: string }[]
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"
const nativeAttachmentMime = (mime: string) =>
  mime === "text/plain" || mime === "application/pdf" || visualAttachmentMime(mime)

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const uploadedPaths = (input.uploadedFiles ?? []).map((attachment) => attachment.path)
  const requestText = [input.text.trim(), ...uploadedPaths].filter(Boolean).join("\n")
  const requestParts: PromptRequestPart[] = requestText
    ? [
        {
          id: Identifier.ascending("part"),
          type: "text",
          text: requestText,
        },
      ]
    : []

  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    const source = attachment.source
      ? {
          ...attachment.source,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
        }
      : {
          type: "file" as const,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
          path,
        }
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime ?? "text/plain",
      url: attachment.url ?? `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: attachment.filename ?? getFilename(attachment.path),
      source,
    } satisfies PromptRequestPart
  })

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = absolute(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) return [filePart]

    const mentions = parseCommentMentions(comment).flatMap((path) => {
      const url = `file://${encodeFilePath(absolute(input.sessionDirectory, path))}`
      if (used.has(url)) return []
      used.add(url)
      return [
        {
          id: Identifier.ascending("part"),
          type: "file",
          mime: "text/plain",
          url,
          filename: getFilename(path),
        } satisfies PromptRequestPart,
      ]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
        metadata: createCommentMetadata({
          path: item.path,
          selection: item.selection,
          comment,
          preview: item.preview,
          origin: item.commentOrigin,
        }),
      } satisfies PromptRequestPart,
      filePart,
      ...mentions,
    ]
  })

  const uploadedImageIDs = new Set(
    (input.uploadedFiles ?? []).flatMap((attachment) => (attachment.id ? [attachment.id] : [])),
  )
  const images = input.images
    .filter((attachment) => !uploadedImageIDs.has(attachment.id))
    .map((attachment) => {
      return {
        id: Identifier.ascending("part"),
        type: "file",
        mime: attachment.mime,
        url: attachment.dataUrl,
        filename: attachment.sourcePath ?? attachment.filename,
      } satisfies PromptRequestPart
    })

  const uploadedFiles = (input.uploadedFiles ?? [])
    // Unknown binary files stay in the path text so the Agent can read them with a tool.
    .filter((attachment) => nativeAttachmentMime(attachment.mime))
    .map((attachment) => {
      const path = attachment.path
      return {
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: attachment.mime,
        url: `file://${encodeFilePath(path)}`,
        filename: attachment.filename,
      } satisfies PromptRequestPart
    })

  requestParts.push(...files, ...context, ...agents, ...uploadedFiles, ...images)

  return {
    requestParts,
    optimisticParts: requestParts.map((part) => toOptimisticPart(part, input.sessionID, input.messageID)),
  }
}
