import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Attachment } from "@opencode-ai/core/attachment"
import { Effect, Exit, Stream } from "effect"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function run<A, E>(effect: Effect.Effect<A, E, Attachment.Service>) {
  const root = await mkdtemp("/flyshop/opencode/tmp/opencode-attachment-")
  roots.push(root)
  return Effect.runPromise(effect.pipe(Effect.provide(Attachment.makeLayer(root))))
}

describe("Attachment", () => {
  test("persists exact offsets and atomically completes arbitrary files", async () => {
    const result = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "archive.bin", mime: "application/octet-stream", size: 4 })
        yield* attachments.append(info.attachmentID, 0, Stream.make(Uint8Array.of(1, 2)))
        const conflict = yield* attachments
          .append(info.attachmentID, 0, Stream.make(Uint8Array.of(9)))
          .pipe(Effect.flip)
        expect(conflict._tag).toBe("AttachmentConflictError")
        expect((yield* attachments.status(info.attachmentID)).offset).toBe(2)
        yield* attachments.append(info.attachmentID, 2, Stream.make(Uint8Array.of(3, 4)))
        return yield* attachments.complete(info.attachmentID)
      }),
    )
    expect(result.filename).toBe("archive.bin")
    expect(Array.from(await readFile(result.path))).toEqual([1, 2, 3, 4])
  })

  test("rejects completion before the declared size is uploaded", async () => {
    const error = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "partial.dat", mime: "application/octet-stream", size: 2 })
        yield* attachments.append(info.attachmentID, 0, Stream.make(Uint8Array.of(1)))
        return yield* attachments.complete(info.attachmentID).pipe(Effect.flip)
      }),
    )
    expect(error._tag).toBe("AttachmentInvalidStateError")
  })

  test("completes zero-byte files", async () => {
    const result = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "empty.txt", mime: "text/plain", size: 0 })
        return yield* attachments.complete(info.attachmentID)
      }),
    )
    expect(result.size).toBe(0)
    expect((await stat(result.path)).size).toBe(0)
  })

  test("rolls back chunks that exceed the declared size", async () => {
    const result = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "bounded.bin", mime: "application/octet-stream", size: 2 })
        const error = yield* attachments
          .append(info.attachmentID, 0, Stream.make(Uint8Array.of(1, 2, 3)))
          .pipe(Effect.flip)
        return { error, status: yield* attachments.status(info.attachmentID) }
      }),
    )
    expect(result.error._tag).toBe("AttachmentInvalidStateError")
    expect(result.status.offset).toBe(0)
  })

  test("serializes concurrent chunks for the same attachment", async () => {
    const result = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "race.bin", mime: "application/octet-stream", size: 1 })
        const outcomes = yield* Effect.all(
          [1, 2].map((byte) => attachments.append(info.attachmentID, 0, Stream.make(Uint8Array.of(byte))).pipe(Effect.exit)),
          { concurrency: "unbounded" },
        )
        return { outcomes, complete: yield* attachments.complete(info.attachmentID) }
      }),
    )
    expect(result.outcomes.filter(Exit.isSuccess)).toHaveLength(1)
    expect(result.outcomes.filter(Exit.isFailure)).toHaveLength(1)
    expect(await readFile(result.complete.path)).toHaveLength(1)
  })

  test("returns the completed attachment when complete is retried", async () => {
    const results = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "retry.txt", mime: "text/plain", size: 1 })
        yield* attachments.append(info.attachmentID, 0, Stream.make(Uint8Array.of(1)))
        return [yield* attachments.complete(info.attachmentID), yield* attachments.complete(info.attachmentID)]
      }),
    )
    expect(results[1]).toEqual(results[0])
  })

  test("converts static raster images to WebP and keeps only the optimized file", async () => {
    const image = await mkdtemp("/flyshop/opencode/tmp/opencode-attachment-image-")
    roots.push(image)
    const source = join(image, "pixel.png")
    const child = Bun.spawn([
      "/usr/bin/ffmpeg",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=2x2:d=0.1",
      "-frames:v",
      "1",
      source,
    ])
    expect(await child.exited).toBe(0)
    const png = await readFile(source)
    const result = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "pixel.png", mime: "image/png", size: png.byteLength })
        yield* attachments.append(info.attachmentID, 0, Stream.make(png))
        return yield* attachments.complete(info.attachmentID)
      }),
    )
    expect(result.filename).toBe("pixel.webp")
    expect(result.mime).toBe("image/webp")
    const bytes = await readFile(result.path)
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF")
    expect(bytes.subarray(8, 12).toString()).toBe("WEBP")
  })

  test("preserves SVG without raster conversion", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')
    const result = await run(
      Effect.gen(function* () {
        const attachments = yield* Attachment.Service
        const info = yield* attachments.init({ name: "icon.svg", mime: "image/svg+xml", size: svg.byteLength })
        yield* attachments.append(info.attachmentID, 0, Stream.make(svg))
        return yield* attachments.complete(info.attachmentID)
      }),
    )
    expect(result.filename).toBe("icon.svg")
    expect(result.mime).toBe("image/svg+xml")
    expect(await readFile(result.path, "utf8")).toContain("<svg")
    expect(result.path).toContain(join("opencode-private", "attachments"))
  })

  test("preserves raster files when optimization fails", async () => {
    const previous = process.env.OPENCODE_FFMPEG_PATH
    process.env.OPENCODE_FFMPEG_PATH = "/missing/opencode-ffmpeg"
    try {
      const bytes = Uint8Array.of(1, 2, 3)
      const result = await run(
        Effect.gen(function* () {
          const attachments = yield* Attachment.Service
          const info = yield* attachments.init({ name: "broken.png", mime: "image/png", size: bytes.length })
          yield* attachments.append(info.attachmentID, 0, Stream.make(bytes))
          return yield* attachments.complete(info.attachmentID)
        }),
      )
      expect(result.filename).toBe("broken.png")
      expect(result.mime).toBe("image/png")
      expect(Array.from(await readFile(result.path))).toEqual([1, 2, 3])
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_FFMPEG_PATH
      else process.env.OPENCODE_FFMPEG_PATH = previous
    }
  })
})
