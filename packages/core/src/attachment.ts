export * as Attachment from "./attachment"

import { Effect, Layer, Context, Schema, Stream } from "effect"
import { randomUUID } from "crypto"
import { basename, extname, join } from "path"
import * as NFS from "fs/promises"
import { Attachment as Contract } from "@opencode-ai/schema/attachment"
import { AbsolutePath } from "./schema"
import { makeGlobalNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"

const Metadata = Schema.Struct({
  attachmentID: Contract.ID,
  filename: Schema.String,
  mime: Schema.String,
  size: Schema.optional(Schema.Int),
  offset: Schema.Int,
  storedSize: Schema.optional(Schema.Int),
  state: Contract.State,
})

type Metadata = typeof Metadata.Type

export const StorageError = Contract.StorageError

export type Error = Contract.NotFoundError | Contract.ConflictError | Contract.InvalidStateError | Contract.StorageError

export interface Interface {
  readonly init: (input: Contract.InitInput) => Effect.Effect<Contract.Info, Contract.StorageError>
  readonly status: (attachmentID: Contract.ID) => Effect.Effect<Contract.Info, Contract.NotFoundError>
  readonly append: (
    attachmentID: Contract.ID,
    offset: number,
    stream: Stream.Stream<Uint8Array, Contract.StorageError>,
  ) => Effect.Effect<{ readonly offset: number }, Error>
  readonly complete: (attachmentID: Contract.ID) => Effect.Effect<Contract.Complete, Error>
  readonly cancel: (attachmentID: Contract.ID) => Effect.Effect<void, Contract.NotFoundError | Contract.InvalidStateError>
  readonly path: (attachmentID: Contract.ID) => Effect.Effect<Contract.Complete, Contract.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Attachment") {}

export const makeLayer = (root?: string) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const namespace = join(root ?? process.env.PFP_PORTAL_NEW_ROOT ?? "/flyshop/opencode/public-file-portal/files", "opencode-private", "attachments")
    const mutex = KeyedMutex.makeUnsafe<Contract.ID>()
    yield* Effect.tryPromise({ try: () => NFS.mkdir(namespace, { recursive: true }), catch: storageError }).pipe(Effect.orDie)

    const metadataPath = (attachmentID: Contract.ID) => join(namespace, `${attachmentID}.json`)
    const partPath = (attachmentID: Contract.ID) => join(namespace, `${attachmentID}.part`)
    const finalPath = (attachmentID: Contract.ID, filename: string) =>
      join(namespace, `${attachmentID}${safeExtension(filename)}`)

    const read = (attachmentID: Contract.ID) =>
      Effect.tryPromise({
        try: async () => Schema.decodeUnknownSync(Metadata)(JSON.parse(await NFS.readFile(metadataPath(attachmentID), "utf8"))),
        catch: () => new Contract.NotFoundError({ message: `Attachment not found: ${attachmentID}` }),
      })

    const write = (metadata: Metadata) =>
      Effect.tryPromise({
        try: async () => {
          const target = metadataPath(metadata.attachmentID)
          const temporary = `${target}.${randomUUID()}.tmp`
          const handle = await NFS.open(temporary, "w", 0o600)
          try {
            await handle.writeFile(JSON.stringify(metadata))
            await handle.sync()
          } finally {
            await handle.close()
          }
          await NFS.rename(temporary, target)
          const directory = await NFS.open(namespace, "r")
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        },
        catch: storageError,
      })

    const toInfo = (metadata: Metadata): Contract.Info => ({
      attachmentID: metadata.attachmentID,
      filename: metadata.filename,
      mime: metadata.mime,
      size: metadata.size,
      offset: metadata.offset,
      state: metadata.state,
    })

    const init = Effect.fn("Attachment.init")(function* (input: Contract.InitInput) {
      const attachmentID = Contract.ID.make(randomUUID())
      const metadata: Metadata = {
        attachmentID,
        filename: basename(input.name),
        mime: input.mime,
        size: input.size,
        offset: 0,
        state: "uploading",
      }
      yield* write(metadata)
      yield* Effect.tryPromise({ try: () => NFS.writeFile(partPath(attachmentID), new Uint8Array(), { mode: 0o600 }), catch: storageError })
      return toInfo(metadata)
    })

    const status = Effect.fn("Attachment.status")(function* (attachmentID: Contract.ID) {
      return toInfo(yield* read(attachmentID))
    })

    const append = Effect.fn("Attachment.append")(function* (
      attachmentID: Contract.ID,
      offset: number,
      stream: Stream.Stream<Uint8Array, Contract.StorageError>,
    ) {
      return yield* mutex.withLock(attachmentID)(
        Effect.gen(function* () {
          const metadata = yield* read(attachmentID)
          if (metadata.state !== "uploading")
            return yield* new Contract.InvalidStateError({ message: `Attachment is ${metadata.state}` })
          if (metadata.offset !== offset)
            return yield* new Contract.ConflictError({ message: `Expected offset ${metadata.offset}`, offset: metadata.offset })
          let written = 0
          const appendChunks = Effect.acquireUseRelease(
            Effect.tryPromise({ try: () => NFS.open(partPath(attachmentID), "a"), catch: storageError }),
            (handle) =>
              Stream.runForEach(stream, (chunk): Effect.Effect<void, Contract.StorageError | Contract.InvalidStateError> =>
                metadata.size !== undefined && metadata.offset + written + chunk.byteLength > metadata.size
                  ? Effect.fail(new Contract.InvalidStateError({ message: `Attachment exceeds declared size ${metadata.size}` }))
                  : Effect.tryPromise({
                      try: async () => {
                        await handle.write(chunk)
                        written += chunk.byteLength
                      },
                      catch: storageError,
                    }),
              ).pipe(Effect.andThen(Effect.tryPromise({ try: () => handle.sync(), catch: storageError }))),
            (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
          )
          yield* appendChunks.pipe(
            Effect.onError(() =>
              Effect.promise(() => NFS.truncate(partPath(attachmentID), metadata.offset).catch(() => undefined)),
            ),
          )
          const next = { ...metadata, offset: metadata.offset + written }
          yield* write(next)
          return { offset: next.offset }
        }),
      )
    })

    const complete = Effect.fn("Attachment.complete")(function* (attachmentID: Contract.ID) {
      return yield* mutex.withLock(attachmentID)(
        Effect.gen(function* () {
          const metadata = yield* read(attachmentID)
          if (metadata.state === "complete") {
            return {
              path: AbsolutePath.make(finalPath(attachmentID, metadata.filename)),
              filename: metadata.filename,
              mime: metadata.mime,
              size: metadata.storedSize ?? metadata.offset,
            }
          }
          if (metadata.state !== "uploading")
            return yield* new Contract.InvalidStateError({ message: `Attachment is ${metadata.state}` })
          if (metadata.size !== undefined && metadata.offset !== metadata.size)
            return yield* new Contract.InvalidStateError({ message: `Attachment is incomplete at ${metadata.offset}` })
          const optimized = yield* optimize(partPath(attachmentID), metadata)
          const destination = finalPath(attachmentID, optimized.filename)
          yield* Effect.tryPromise({ try: () => NFS.rename(optimized.path, destination), catch: storageError })
          const next = {
            ...metadata,
            filename: optimized.filename,
            mime: optimized.mime,
            storedSize: optimized.size,
            state: "complete" as const,
          }
          yield* write(next).pipe(
            Effect.catch((error) =>
              (optimized.path === partPath(attachmentID)
                ? Effect.tryPromise({ try: () => NFS.rename(destination, partPath(attachmentID)), catch: storageError })
                : Effect.void
              ).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
          if (optimized.path !== partPath(attachmentID))
            yield* Effect.promise(() => NFS.rm(partPath(attachmentID), { force: true }).catch(() => undefined))
          return { path: AbsolutePath.make(destination), filename: optimized.filename, mime: optimized.mime, size: optimized.size }
        }),
      )
    })

    const cancel = Effect.fn("Attachment.cancel")(function* (attachmentID: Contract.ID) {
      yield* mutex.withLock(attachmentID)(
        Effect.gen(function* () {
          const metadata = yield* read(attachmentID)
          if (metadata.state !== "uploading")
            return yield* new Contract.InvalidStateError({ message: `Attachment is ${metadata.state}` })
          yield* Effect.tryPromise({ try: () => Promise.all([NFS.rm(partPath(attachmentID), { force: true }), NFS.rm(metadataPath(attachmentID), { force: true })]), catch: () => new Contract.NotFoundError({ message: `Attachment not found: ${attachmentID}` }) })
        }),
      )
    })

    const path = Effect.fn("Attachment.path")(function* (attachmentID: Contract.ID) {
      const metadata = yield* read(attachmentID)
      if (metadata.state !== "complete") return yield* new Contract.NotFoundError({ message: `Attachment is not complete: ${attachmentID}` })
      return {
        path: AbsolutePath.make(finalPath(attachmentID, metadata.filename)),
        filename: metadata.filename,
        mime: metadata.mime,
        size: metadata.storedSize ?? metadata.offset,
      }
    })

    return Service.of({ init, status, append, complete, cancel, path })
  }),
)

const layer = makeLayer()

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

function safeExtension(filename: string) {
  const extension = extname(filename).toLowerCase()
  return /^[.][a-z0-9]{1,12}$/.test(extension) ? extension : ""
}

function storageError(cause: unknown) {
  return new Contract.StorageError({ message: cause instanceof Error ? cause.message : String(cause) })
}

const optimize = Effect.fn("Attachment.optimize")(function* (path: string, metadata: Metadata) {
  if (!new Set(["image/png", "image/jpeg", "image/bmp", "image/tiff"]).has(metadata.mime))
    return { path, filename: metadata.filename, mime: metadata.mime, size: metadata.offset }
  const output = `${path}.webp`
  const result = yield* Effect.promise(async () => {
    try {
      const child = Bun.spawn([
        process.env.OPENCODE_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        "-frames:v",
        "1",
        "-c:v",
        "libwebp",
        "-quality",
        "82",
        output,
      ], { stdout: "ignore", stderr: "pipe" })
      if ((await child.exited) !== 0) return undefined
      const stat = await NFS.stat(output)
      return {
        path: output,
        filename: `${basename(metadata.filename, extname(metadata.filename))}.webp`,
        mime: "image/webp",
        size: stat.size,
      }
    } catch {
      return undefined
    }
  })
  if (result) return result
  yield* Effect.promise(() => NFS.rm(output, { force: true }).catch(() => undefined))
  return { path, filename: metadata.filename, mime: metadata.mime, size: metadata.offset }
})
