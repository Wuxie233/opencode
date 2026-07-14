import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option, Tracer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http"
import { compressBody, compressionLayer } from "../../src/server/routes/instance/httpapi/middleware/compression"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

it.live("moves buffered compression off the current JavaScript turn", () =>
  Effect.gen(function* () {
    const input = new TextEncoder().encode("compression-work-".repeat(65_536))

    for (const encoding of ["gzip", "deflate"] as const) {
      const fiber = Effect.runFork(compressBody(input, encoding))
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect((yield* Fiber.join(fiber)).byteLength).toBeGreaterThan(0)
    }
  }),
)

it.live("attributes compressed response bytes and encoding", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })

    yield* HttpRouter.add(
      "GET",
      "/large",
      Effect.succeed(HttpServerResponse.text("x".repeat(4096))),
    ).pipe(
      Layer.provide(compressionLayer),
      HttpRouter.serve,
      Layer.provide(Layer.succeed(Tracer.Tracer, tracer)),
      Layer.build,
    )

    const response = yield* HttpClientRequest.get("/large").pipe(
      HttpClientRequest.setHeader("accept-encoding", "gzip"),
      HttpClient.execute,
    )
    expect(response.status).toBe(200)
    expect(response.headers["content-encoding"]).toBe("gzip")
    yield* response.arrayBuffer

    const span = spans.findLast((item) => item.name === "HttpApi.compress")
    const parent = Option.getOrUndefined(span?.parent ?? Option.none())
    expect(parent?._tag).toBe("Span")
    if (parent?._tag !== "Span") return
    expect(parent.attributes.get("http.response.body.size")).toBeLessThan(4096)
    expect(span?.attributes.get("opencode.http.response.body.uncompressed_size")).toBe(4096)
    expect(span?.attributes.get("opencode.http.response.body.compressed_size")).toBeNumber()
    expect(span?.attributes.get("opencode.http.response.content_encoding")).toBe("gzip")
  }),
)
