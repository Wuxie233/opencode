import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { IncomingMessage } from "node:http"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceContextMiddleware, instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  workspaceRoutingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Session } from "../../src/session/session"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"

const it = testEffect(
  Layer.mergeAll(
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true }),
  ),
)

const ProbeApi = HttpApi.make("wave8-http-verifier").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("plain", "/plain", { query: WorkspaceRoutingQuery, success: Schema.String }),
      HttpApiEndpoint.get("success", "/success", {
        query: WorkspaceRoutingQuery,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain" })),
      }),
      HttpApiEndpoint.get("failed", "/failed", {
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

type SocketObservation = {
  readonly socket: IncomingMessage["socket"]
  readonly closeListeners: number
}

const observeSocket = (deferred: Deferred.Deferred<SocketObservation>) =>
  HttpServerRequest.HttpServerRequest.use((request) => {
    if (!(request.source instanceof IncomingMessage)) return Effect.void
    return Deferred.succeed(deferred, {
      socket: request.source.socket,
      closeListeners: request.source.socket.listenerCount("close"),
    }).pipe(Effect.asVoid)
  })

const serve = (input: {
  streamStarted: Deferred.Deferred<void>
  successSocket: Deferred.Deferred<SocketObservation>
  cancelledSocket: Deferred.Deferred<SocketObservation>
}) =>
  HttpApiBuilder.layer(ProbeApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
        handlers
          .handle("plain", () => Effect.succeed("plain"))
          .handleRaw("success", () =>
            observeSocket(input.successSocket).pipe(
              Effect.as(HttpServerResponse.stream(Stream.make("success").pipe(Stream.encodeText))),
            ),
          )
          .handleRaw("failed", () =>
            Effect.succeed(
              HttpServerResponse.stream(
                Stream.make("partial").pipe(
                  Stream.concat(Stream.fail(new Error("stream failed"))),
                  Stream.encodeText,
                ),
              ),
            ),
          )
          .handleRaw("cancelled", () =>
            observeSocket(input.cancelledSocket).pipe(
              Effect.as(
                HttpServerResponse.stream(
                  Stream.fromEffect(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(input.streamStarted, undefined)
                      return "started"
                    }),
                  ).pipe(
                    Stream.concat(Stream.never),
                    Stream.encodeText,
                  ),
                ),
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
  it.effect("releases plain, successful, failed, and cancelled response leases", () =>
    Effect.gen(function* () {
      const directories = yield* Effect.all(
        [
          tmpdirScoped({ git: true }),
          tmpdirScoped({ git: true }),
          tmpdirScoped({ git: true }),
          tmpdirScoped({ git: true }),
        ] as const,
        { concurrency: "unbounded" },
      )
      const [plainDirectory, successDirectory, failedDirectory, cancelledDirectory] = directories
      const disposed: string[] = []
      const streamStarted = yield* Deferred.make<void>()
      const successSocket = yield* Deferred.make<SocketObservation>()
      const cancelledSocket = yield* Deferred.make<SocketObservation>()
      const unregister = registerDisposer(async (directory) => void disposed.push(directory))
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      yield* serve({ streamStarted, successSocket, cancelledSocket })

      const plain = yield* HttpClient.get(`/plain?directory=${encodeURIComponent(plainDirectory)}`)
      expect(yield* plain.text).toBe(JSON.stringify("plain"))

      const success = yield* HttpClient.get(`/success?directory=${encodeURIComponent(successDirectory)}`)
      expect(yield* success.text).toBe("success")
      const successfulConnection = yield* Deferred.await(successSocket)
      expect(successfulConnection.socket.listenerCount("close")).toBe(successfulConnection.closeListeners)

      const failed = yield* HttpClient.get(`/failed?directory=${encodeURIComponent(failedDirectory)}`)
      expect(yield* failed.text).toBe("partial")

      const baseUrl = yield* HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))
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
  socket.write(
    "GET " + target.pathname + target.search + " HTTP/1.1\\r\\n" +
    "Host: " + target.host + "\\r\\n" +
    "Connection: close\\r\\n\\r\\n"
  )
})
socket.once("data", () => socket.destroy())
socket.once("close", () => process.exit(0))
socket.once("error", (error) => {
  if (error.code !== "ECONNRESET") throw error
})
setTimeout(() => process.exit(1), 2_000)`,
              `${baseUrl}/cancelled?directory=${encodeURIComponent(cancelledDirectory)}`,
            ],
            { stderr: "pipe" },
          )
          const exitCode = await process.exited
          if (exitCode === 0) return
          throw new Error(await new Response(process.stderr).text())
        },
        catch: (cause) => cause,
      })
      yield* Deferred.await(streamStarted)
      yield* TestClock.adjust("15 minutes")
      const cancelledConnection = yield* Deferred.await(cancelledSocket)
      expect(cancelledConnection.socket.listenerCount("close")).toBe(cancelledConnection.closeListeners)
      expect(disposed.filter((directory) => directory === plainDirectory)).toHaveLength(1)
      expect(disposed.filter((directory) => directory === successDirectory)).toHaveLength(1)
      expect(disposed.filter((directory) => directory === failedDirectory)).toHaveLength(1)
      expect(disposed.filter((directory) => directory === cancelledDirectory)).toHaveLength(1)
    }),
    30_000,
  )
})
