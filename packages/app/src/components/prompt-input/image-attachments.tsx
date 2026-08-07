import { Component, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { AttachmentCardV2 } from "@opencode-ai/session-ui/v2/attachment-card-v2"
import { CommentCardV2 } from "@opencode-ai/session-ui/v2/comment-card-v2"
import { typeLabel } from "@opencode-ai/session-ui/message-file"
import type { ContextItem, ImageAttachmentPart } from "@/context/prompt"
import "./image-attachments.css"

type PromptCommentItem = ContextItem & { key: string }

type PromptImageAttachmentsProps = {
  attachments: ImageAttachmentPart[]
  onOpen: (attachment: ImageAttachmentPart) => void
  onRemove: (attachment: ImageAttachmentPart) => void
  onRetry: (attachment: ImageAttachmentPart) => void
  onCancel: (attachment: ImageAttachmentPart) => void
  onDownload: (attachment: ImageAttachmentPart) => void
  removeLabel: string
  fileLabel: string
  newLayoutDesigns: boolean
  comments?: PromptCommentItem[]
  commentActive?: (item: PromptCommentItem) => boolean
  onOpenComment?: (item: PromptCommentItem) => void
  onRemoveComment?: (item: PromptCommentItem) => void
}

const fallbackClass = "size-16 rounded-md bg-surface-base flex items-center justify-center border border-border-base"
const imageClass =
  "size-16 rounded-md object-cover border border-border-base hover:border-border-strong-base transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.02]"
const imageClassV2 =
  "w-[58px] h-[46px] rounded-[6px] object-cover transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:transform-none"
// inset box-shadows do not paint over <img> content, so the hairline is a separate overlay
const imageHairlineClassV2 =
  "absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-base)] pointer-events-none"
const removeClass =
  "absolute -top-1.5 -right-1.5 z-20 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-[opacity,transform,background-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-105 hover:bg-surface-raised-base-hover motion-reduce:transition-none motion-reduce:transform-none"
const removeClassV2 =
  "absolute -top-1 -right-1 z-20 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-105 motion-reduce:transition-none motion-reduce:transform-none"
const nameClass = "absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md"

export const PromptImageAttachments: Component<PromptImageAttachmentsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0 || (props.newLayoutDesigns && (props.comments?.length ?? 0) > 0)}>
      <div data-slot="prompt-attachments" classList={{ relative: props.newLayoutDesigns }}>
        <div
          data-slot="prompt-attachments-scroll"
          classList={{
            "flex gap-2": true,
            "flex-nowrap overflow-x-auto no-scrollbar px-2 pt-2 pb-1": props.newLayoutDesigns,
            "flex-wrap px-3 pt-3": !props.newLayoutDesigns,
          }}
        >
          <Show when={props.newLayoutDesigns}>
            <For each={props.comments ?? []}>
              {(item) => (
                <div class="relative group shrink-0">
                  <TooltipV2
                    value={item.comment}
                    placement="top"
                    openDelay={800}
                    contentClass="max-w-[300px] break-words"
                  >
                    <CommentCardV2
                      comment={item.comment ?? ""}
                      path={item.path}
                      selection={item.selection}
                      active={props.commentActive?.(item)}
                      onClick={() => props.onOpenComment?.(item)}
                    />
                  </TooltipV2>
                  <button
                    type="button"
                    onClick={() => props.onRemoveComment?.(item)}
                    class={removeClassV2}
                    aria-label={props.removeLabel}
                  >
                    <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                  </button>
                </div>
              )}
            </For>
          </Show>
          <For each={props.attachments}>
            {(attachment) => {
              const image = attachment.mime.startsWith("image/")
              const media = () => (
                <Show
                  when={image}
                  fallback={
                    <Show
                      when={props.newLayoutDesigns}
                      fallback={
                        <div class={fallbackClass}>
                          <Icon name="folder" class="size-6 text-text-weak" />
                        </div>
                      }
                    >
                      <AttachmentCardV2 title={attachment.filename}>
                        {typeLabel(attachment.filename, attachment.mime, props.fileLabel)}
                      </AttachmentCardV2>
                    </Show>
                  }
                >
                  <img
                    src={attachment.blob.url}
                    alt={attachment.filename}
                    class={props.newLayoutDesigns ? imageClassV2 : imageClass}
                    onClick={() => props.onOpen(attachment)}
                  />
                </Show>
              )
              const name = () => (
                <div class={nameClass}>
                  <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
                </div>
              )
              const remove = () => {
                const uploading = attachment.upload?.status === "uploading"
                return (
                  <button
                    type="button"
                    onClick={() => (uploading ? props.onCancel(attachment) : props.onRemove(attachment))}
                    class={props.newLayoutDesigns ? removeClassV2 : removeClass}
                    aria-label={uploading ? "Cancel upload" : props.removeLabel}
                  >
                    <Show
                      when={props.newLayoutDesigns}
                      fallback={<Icon name={uploading ? "stop" : "close"} class="size-3 text-text-weak" />}
                    >
                      <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                    </Show>
                  </button>
                )
              }
              const status = () => (
                <Show when={attachment.upload?.status === "failed"}>
                  <button
                    type="button"
                    onClick={() => props.onRetry(attachment)}
                    class="prompt-attachment-status absolute inset-0 z-10 flex items-center justify-center rounded-[6px] bg-black/55 text-white"
                    aria-label="Retry upload"
                  >
                    <Icon name="reset" class="size-4" />
                  </button>
                </Show>
              )
              const download = () => (
                <Show when={attachment.upload?.status === "complete"}>
                  <button
                    type="button"
                    onClick={() => props.onDownload(attachment)}
                    class="absolute right-1 bottom-1 z-10 flex size-5 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:opacity-100 group-hover:scale-105 motion-reduce:transition-none motion-reduce:transform-none"
                    aria-label="Download attachment"
                  >
                    <Icon name="download" class="size-3" />
                  </button>
                </Show>
              )
              const progress = () => (
                <Show when={attachment.upload?.status === "uploading"}>
                  <div class="absolute inset-x-1 bottom-1 z-10 h-1 overflow-hidden rounded-full bg-black/30">
                    <div
                      class="prompt-attachment-progress h-full origin-left bg-white"
                      style={{ transform: `scaleX(${attachment.upload?.progress ?? 0})` }}
                    />
                  </div>
                </Show>
              )
              // v2 keeps the remove button outside the tooltip trigger so hovering it dismisses the tooltip
              return (
                <Show
                  when={props.newLayoutDesigns}
                  fallback={
                    <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
                      <div class="relative group prompt-attachment-enter">
                        {media()}
                        {name()}
                        {status()}
                        {progress()}
                        {download()}
                        {remove()}
                      </div>
                    </Tooltip>
                  }
                >
                  <div class="relative group shrink-0 prompt-attachment-enter">
                    <TooltipV2 value={attachment.filename} placement="top" contentClass="break-all">
                      {media()}
                      {status()}
                      {progress()}
                      {download()}
                      <Show when={image}>
                        <div class={imageHairlineClassV2} />
                      </Show>
                    </TooltipV2>
                    {remove()}
                  </div>
                </Show>
              )
            }}
          </For>
        </div>
        <Show when={props.newLayoutDesigns}>
          <div
            data-slot="prompt-attachments-fade-left"
            class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)]"
          />
          <div
            data-slot="prompt-attachments-fade-right"
            class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)]"
          />
        </Show>
      </div>
    </Show>
  )
}
