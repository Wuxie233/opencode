import { Attachment } from "@opencode-ai/schema/attachment"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const root = "/api/attachment"
const IDParams = { attachmentID: Attachment.ID }

export const AttachmentGroup = HttpApiGroup.make("server.attachment")
  .add(
    HttpApiEndpoint.post("attachment.init", root, {
      payload: Attachment.InitInput,
      success: Attachment.Info,
      error: Attachment.StorageError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.attachment.init" })),
  )
  .add(
    HttpApiEndpoint.get("attachment.status", `${root}/:attachmentID`, {
      params: IDParams,
      success: Attachment.Info,
      error: Attachment.NotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.attachment.status" })),
  )
  .add(
    HttpApiEndpoint.patch("attachment.chunk", `${root}/:attachmentID`, {
      params: IDParams,
      headers: Schema.Struct({
        "upload-offset": Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt)),
      }),
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: Schema.Struct({ offset: NonNegativeInt }),
      error: [Attachment.NotFoundError, Attachment.ConflictError, Attachment.InvalidStateError, Attachment.StorageError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.attachment.chunk" })),
  )
  .add(
    HttpApiEndpoint.post("attachment.complete", `${root}/:attachmentID/complete`, {
      params: IDParams,
      success: Attachment.Complete,
      error: [Attachment.NotFoundError, Attachment.ConflictError, Attachment.InvalidStateError, Attachment.StorageError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.attachment.complete" })),
  )
  .add(
    HttpApiEndpoint.delete("attachment.cancel", `${root}/:attachmentID`, {
      params: IDParams,
      success: HttpApiSchema.NoContent,
      error: [Attachment.NotFoundError, Attachment.InvalidStateError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.attachment.cancel" })),
  )
  .add(
    HttpApiEndpoint.get("attachment.content", `${root}/:attachmentID/content`, {
      params: IDParams,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: Attachment.NotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.attachment.content" })),
  )
  .annotateMerge(OpenApi.annotations({ title: "attachments", description: "Private resumable attachment routes." }))
