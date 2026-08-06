export * as Attachment from "./attachment"

import { Schema } from "effect"
import { AbsolutePath, NonNegativeInt, optional } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("Attachment.ID"))
export type ID = typeof ID.Type

export const State = Schema.Literals(["uploading", "complete", "cancelled"])
export type State = typeof State.Type

export const InitInput = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  mime: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  size: optional(NonNegativeInt),
}).annotate({ identifier: "Attachment.InitInput" })
export type InitInput = typeof InitInput.Type

export const Info = Schema.Struct({
  attachmentID: ID,
  filename: Schema.String,
  mime: Schema.String,
  size: optional(NonNegativeInt),
  offset: NonNegativeInt,
  state: State,
}).annotate({ identifier: "Attachment.Info" })
export type Info = typeof Info.Type

export const Complete = Schema.Struct({
  path: AbsolutePath,
  filename: Schema.String,
  mime: Schema.String,
  size: NonNegativeInt,
}).annotate({ identifier: "Attachment.Complete" })
export type Complete = typeof Complete.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("AttachmentNotFoundError", {
  message: Schema.String,
}, { httpApiStatus: 404 }) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("AttachmentConflictError", {
  message: Schema.String,
  offset: NonNegativeInt,
}, { httpApiStatus: 409 }) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("AttachmentInvalidStateError", {
  message: Schema.String,
}, { httpApiStatus: 409 }) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("AttachmentStorageError", {
  message: Schema.String,
}, { httpApiStatus: 500 }) {}
