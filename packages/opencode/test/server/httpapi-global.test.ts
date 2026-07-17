import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Option, Queue, Schema, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { GlobalBus } from "@/bus/global"

const GlobalEvent = Schema.Struct({
  directory: Schema.optional(Schema.String),
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.String,
  }),
})

const openEvents = (path: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(path)
    const reader = yield* Queue.unbounded<Uint8Array>()
    const fiber = yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { reader, fiber }
  })

const nextEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Queue.take(reader).pipe(
    Effect.map((value) =>
      Schema.decodeUnknownSync(GlobalEvent)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ""))),
    ),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for global event")),
    }),
  )

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )

  it.live("preserves sync events by default for older clients", () =>
    Effect.gen(function* () {
      const { reader, fiber } = yield* openEvents(GlobalPaths.event)
      expect(yield* nextEvent(reader)).toMatchObject({ payload: { type: "server.connected" } })

      GlobalBus.emit("event", { directory: "/repo", payload: { type: "sync", syncEvent: { id: "evt_sync" } } })
      expect(yield* nextEvent(reader)).toMatchObject({ directory: "/repo", payload: { type: "sync" } })
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("filters sync events before enqueue when explicitly disabled", () =>
    Effect.gen(function* () {
      const { reader, fiber } = yield* openEvents(`${GlobalPaths.event}?include_sync=false`)
      expect(yield* nextEvent(reader)).toMatchObject({ payload: { type: "server.connected" } })

      GlobalBus.emit("event", { directory: "/repo", payload: { type: "sync", syncEvent: { id: "evt_sync" } } })
      GlobalBus.emit("event", { directory: "/repo", payload: { type: "custom.event", properties: {} } })
      expect(yield* nextEvent(reader)).toMatchObject({ directory: "/repo", payload: { type: "custom.event" } })
      yield* Fiber.interrupt(fiber)
    }),
  )
})
