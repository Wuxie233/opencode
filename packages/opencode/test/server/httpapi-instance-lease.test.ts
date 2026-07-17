import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { registerDisposer } from "../../src/effect/instance-registry"
import {
  InstanceContextMiddleware,
  instanceContextLayer,
} from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Session } from "../../src/session/session"
import { tmpdirScoped } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true }),
  ),
)

const ProbeApi = HttpApi.make("instance-lease-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("plain", "/plain", { query: WorkspaceRoutingQuery, success: Schema.String }),
      HttpApiEndpoint.get("stream", "/stream", {
        query: WorkspaceRoutingQuery,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain" })),
      }),
      HttpApiEndpoint.get("cancelled", "/cancelled", {
        query: WorkspaceRoutingQuery,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain" })),
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware),
)

const serve = (started: Deferred.Deferred<void>, finish: Deferred.Deferred<void>, cancelled: Deferred.Deferred<void>) =>
  HttpApiBuilder.layer(ProbeApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
        handlers
          .handle("plain", () => Effect.succeed("plain"))
          .handleRaw("stream", () =>
            Effect.succeed(
              HttpServerResponse.stream(
                Stream.fromEffect(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined)
                    return "started"
                  }),
                ).pipe(
                  Stream.concat(Stream.fromEffect(Deferred.await(finish).pipe(Effect.as("finished")))),
                  Stream.encodeText,
                ),
              ),
            ),
          )
          .handleRaw("cancelled", () =>
            Effect.succeed(
              HttpServerResponse.stream(
                Stream.fromEffect(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(cancelled, undefined)
                    return "started"
                  }),
                ).pipe(Stream.concat(Stream.never), Stream.encodeText),
              ),
            ),
          ),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        instanceContextLayer,
        workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      ),
    ),
    Layer.provide(Layer.mock(Session.Service)({})),
    HttpRouter.serve,
    Layer.build,
  )

describe("HttpApi instance lease lifecycle", () => {
  it.effect("keeps streaming requests leased until the response body completes", () =>
    Effect.gen(function* () {
      const plainDirectory = yield* tmpdirScoped({ git: true })
      const streamDirectory = yield* tmpdirScoped({ git: true })
      const disposed: string[] = []
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const unregister = registerDisposer(async (directory) => void disposed.push(directory))
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      yield* serve(started, finish, cancelled)

      const plain = yield* HttpClient.get(`/plain?directory=${encodeURIComponent(plainDirectory)}`)
      expect(yield* plain.text).toBe(JSON.stringify("plain"))

      const response = yield* HttpClient.get(`/stream?directory=${encodeURIComponent(streamDirectory)}`)
      const body = yield* response.text.pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([plainDirectory])

      yield* Deferred.succeed(finish, undefined)
      expect(yield* Fiber.join(body)).toBe("startedfinished")
      yield* TestClock.adjust("15 minutes")
      expect(disposed).toEqual([plainDirectory, streamDirectory])
    }),
  )

  it.effect("releases streaming requests when the client disconnects", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const disposed: string[] = []
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const unregister = registerDisposer(async (current) => void disposed.push(current))
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      yield* serve(started, finish, cancelled)

      const baseUrl = yield* HttpServer.HttpServer.use((server) =>
        Effect.succeed(HttpServer.formatAddress(server.address)),
      )
      yield* Effect.tryPromise({
        try: async () => {
          const process = Bun.spawn(
            [
              "node",
              "-e",
              `const { createConnection } = require("node:net")
const target = new URL(process.argv[1])
const socket = createConnection({ host: target.hostname, port: Number(target.port) })
socket.once("connect", () => {
  socket.write("GET " + target.pathname + target.search + " HTTP/1.1\\r\\nHost: " + target.host + "\\r\\nConnection: close\\r\\n\\r\\n")
})
socket.once("data", () => socket.destroy())
socket.once("close", () => process.exit(0))
socket.once("error", (error) => {
  if (error.code !== "ECONNRESET") throw error
})
setTimeout(() => process.exit(1), 2_000)`,
              `${baseUrl}/cancelled?directory=${encodeURIComponent(directory)}`,
            ],
            { stderr: "pipe" },
          )
          const exitCode = await process.exited
          if (exitCode === 0) return
          throw new Error(await new Response(process.stderr).text())
        },
        catch: (cause) => cause,
      })
      yield* Deferred.await(cancelled)
      yield* TestClock.adjust("15 minutes")

      expect(disposed).toEqual([directory])
    }),
  )
})
