import { Attachment } from "@opencode-ai/core/attachment"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const AttachmentHandler = HttpApiBuilder.group(Api, "server.attachment", (handlers) =>
  Effect.succeed(
    handlers
      .handle("attachment.init", (ctx) => Attachment.Service.use((attachments) => attachments.init(ctx.payload)))
      .handle("attachment.status", (ctx) => Attachment.Service.use((attachments) => attachments.status(ctx.params.attachmentID)))
      .handleRaw("attachment.chunk", (ctx) =>
        Attachment.Service.use((attachments) =>
          attachments.append(ctx.params.attachmentID, ctx.headers["upload-offset"], ctx.request.stream.pipe(
            Stream.mapError((error) => new Attachment.StorageError({ message: String(error) })),
          )).pipe(
            Effect.map(HttpServerResponse.jsonUnsafe),
          ),
        ),
      )
      .handle("attachment.complete", (ctx) =>
        Attachment.Service.use((attachments) => attachments.complete(ctx.params.attachmentID)),
      )
      .handle("attachment.cancel", (ctx) =>
        Attachment.Service.use((attachments) =>
          attachments.cancel(ctx.params.attachmentID).pipe(Effect.as(HttpApiSchema.NoContent.make())),
        ),
      )
      .handleRaw("attachment.content", (ctx) =>
        Attachment.Service.use((attachments) =>
          attachments.path(ctx.params.attachmentID).pipe(
            Effect.map((file) =>
              HttpServerResponse.stream(
                Stream.fromReadableStream({
                  evaluate: () => Bun.file(file.path).stream(),
                  onError: (error) => error,
                }),
                {
                  contentType: file.mime,
                  contentLength: file.size,
                  headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` },
                },
              ),
            ),
          ),
        ),
      ),
  ),
)
