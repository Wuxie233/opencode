import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { Attachment } from "@opencode-ai/core/attachment"
import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AttachmentHandler } from "@opencode-ai/server/handlers/attachment"
import { AttachmentGroup } from "@opencode-ai/protocol/groups/attachment"
import { HttpApi } from "effect/unstable/httpapi"
import { authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { ServerAuth } from "@opencode-ai/server/auth"
import { schemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function handler() {
  const root = await mkdtemp("/flyshop/opencode/tmp/opencode-attachment-http-")
  roots.push(root)
  const api = HttpApi.make("server").add(AttachmentGroup)
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(AttachmentHandler),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() })),
      Layer.provide(Attachment.makeLayer(root)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
}

const context = Context.empty() as Context.Context<unknown>

describe("attachment HttpApi", () => {
  test("streams chunks and serves completed private content", async () => {
    const app = await handler()
    const init = await app.handler(
      new Request("http://localhost/api/attachment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "hello world.txt", mime: "text/plain", size: 5 }),
      }),
      context,
    )
    expect(init.status).toBe(200)
    const info = (await init.json()) as { attachmentID: string }

    const chunk = await app.handler(
      new Request(`http://localhost/api/attachment/${info.attachmentID}`, {
        method: "PATCH",
        headers: { "content-type": "application/octet-stream", "upload-offset": "0" },
        body: "hello",
      }),
      context,
    )
    expect(chunk.status).toBe(200)
    expect(await chunk.json()).toEqual({ offset: 5 })

    const complete = await app.handler(
      new Request(`http://localhost/api/attachment/${info.attachmentID}/complete`, { method: "POST" }),
      context,
    )
    expect(complete.status).toBe(200)
    const result = (await complete.json()) as { path: string }
    expect(result.path).toContain("opencode-private/attachments")
    expect(await readFile(result.path, "utf8")).toBe("hello")

    const content = await app.handler(
      new Request(`http://localhost/api/attachment/${info.attachmentID}/content`),
      context,
    )
    expect(content.status).toBe(200)
    expect(content.headers.get("content-type")).toContain("text/plain")
    expect(content.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''hello%20world.txt")
    expect(await content.text()).toBe("hello")
    await app.dispose()
  })

  test("returns the authoritative offset on a chunk conflict", async () => {
    const app = await handler()
    const init = await app.handler(
      new Request("http://localhost/api/attachment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "resume.bin", mime: "application/octet-stream", size: 1 }),
      }),
      context,
    )
    const info = (await init.json()) as { attachmentID: string }
    const conflict = await app.handler(
      new Request(`http://localhost/api/attachment/${info.attachmentID}`, {
        method: "PATCH",
        headers: { "content-type": "application/octet-stream", "upload-offset": "1" },
        body: Uint8Array.of(1),
      }),
      context,
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ _tag: "AttachmentConflictError", offset: 0 })
    await app.dispose()
  })
})
