import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Stream } from "effect"
import { HttpBody, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import {
  measure,
  requestPerformanceLayer,
} from "../../src/server/routes/instance/httpapi/middleware/request-performance"

type Event = Record<string, unknown>
type Routes = HttpRouter.HttpRouter | HttpRouter.Request<"Error", HttpServerResponse.HttpServerResponse>

function app(routes: Layer.Layer<never, never, Routes>, events: Event[]) {
  const capture = Logger.layer(
    [
      Logger.make((options) => {
        const message = Array.isArray(options.message) ? options.message[0] : options.message
        if (message && typeof message === "object") events.push(message as Event)
      }),
    ],
    { mergeWithExisting: false },
  )
  return HttpRouter.toWebHandler(Layer.merge(routes, capture).pipe(Layer.provide(requestPerformanceLayer)), {
    disableLogger: true,
  })
}

describe("HttpApi request performance logging", () => {
  test("logs normalized route, status, total, and phases without request data", async () => {
    const events: Event[] = []
    const handler = app(
      HttpRouter.add(
        "GET",
        "/session/:sessionID/message",
        measure(
          "handler",
          Effect.sleep("5 millis").pipe(Effect.as(HttpServerResponse.text("response-secret", { status: 503 }))),
        ),
      ),
      events,
    )
    try {
      const response = await handler.handler(
        new Request("http://localhost/session/ses_sensitive/message?token=query-secret", {
          headers: { authorization: "Bearer header-secret", "x-opencode-directory": "/private/directory" },
        }),
      )
      expect(response.status).toBe(503)
      expect(await response.text()).toBe("response-secret")
    } finally {
      await handler.dispose()
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: "http_request",
      method: "GET",
      route: "/session/:sessionID/message",
      status: 503,
    })
    expect(events[0].total_ms).toBeNumber()
    expect(events[0].handler_ms).toBeNumber()
    expect(JSON.stringify(events[0])).not.toContain("ses_sensitive")
    expect(JSON.stringify(events[0])).not.toContain("query-secret")
    expect(JSON.stringify(events[0])).not.toContain("header-secret")
    expect(JSON.stringify(events[0])).not.toContain("/private/directory")
    expect(JSON.stringify(events[0])).not.toContain("response-secret")
  })

  test("keeps concurrent request phase timings isolated", async () => {
    const events: Event[] = []
    const handler = app(
      Layer.merge(
        HttpRouter.add(
          "GET",
          "/fast/:id",
          measure("workspace_route", Effect.sleep("2 millis").pipe(Effect.as(HttpServerResponse.empty()))),
        ),
        HttpRouter.add(
          "GET",
          "/slow/:id",
          measure("proxy", Effect.sleep("15 millis").pipe(Effect.as(HttpServerResponse.empty()))),
        ),
      ),
      events,
    )
    try {
      await Promise.all([
        handler.handler(new Request("http://localhost/fast/private-fast")),
        handler.handler(new Request("http://localhost/slow/private-slow")),
      ])
    } finally {
      await handler.dispose()
    }

    expect(events).toHaveLength(2)
    const fast = events.find((item) => item.route === "/fast/:id")
    const slow = events.find((item) => item.route === "/slow/:id")
    expect(fast?.workspace_route_ms).toBeNumber()
    expect(fast?.proxy_ms).toBeUndefined()
    expect(slow?.proxy_ms).toBeNumber()
    expect(slow?.workspace_route_ms).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain("private-fast")
    expect(JSON.stringify(events)).not.toContain("private-slow")
  })

  test("logs the final status when an Effect failure becomes the response", async () => {
    const events: Event[] = []
    const handler = app(
      HttpRouter.add("GET", "/failed", Effect.fail(HttpServerResponse.text("private-error", { status: 422 }))),
      events,
    )
    try {
      const response = await handler.handler(new Request("http://localhost/failed?secret=query-value"))
      expect(response.status).toBe(422)
      expect(await response.text()).toBe("private-error")
    } finally {
      await handler.dispose()
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: "http_request", route: "/failed", status: 422 })
    expect(JSON.stringify(events[0])).not.toContain("private-error")
    expect(JSON.stringify(events[0])).not.toContain("query-value")
  })

  test("logs streaming requests when the response is ready and skips UI catch-all", async () => {
    const events: Event[] = []
    const handler = app(
      Layer.merge(
        HttpRouter.add(
          "GET",
          "/event",
          Effect.succeed(
            HttpServerResponse.setBody(
              HttpServerResponse.empty({ status: 200 }),
              HttpBody.stream(Stream.never, "text/event-stream"),
            ),
          ),
        ),
        HttpRouter.add("GET", "/*", HttpServerResponse.text("asset")),
      ),
      events,
    )
    try {
      const stream = await handler.handler(new Request("http://localhost/event"))
      expect(stream.status).toBe(200)
      await stream.body?.cancel()
      const asset = await handler.handler(new Request("http://localhost/app.js?token=asset-secret"))
      expect(asset.status).toBe(200)
    } finally {
      await handler.dispose()
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: "http_request", route: "/event", status: 200 })
  })
})
