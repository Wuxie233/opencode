import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"
import { provideInstanceEffect, TestInstance } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(MCP.node))

const serve = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Headers[] = []
    const protocol = new Server({ name: "headers", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new Headers(request.headers))
        return transport.handleRequest(request)
      },
    })
    return {
      requests,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default)", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      const result = yield* mcp.add("test-server", {
        type: "remote",
        url: server.url,
        headers: {
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        },
      })

      expect(result.status).toMatchObject({ "test-server": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-token")
        expect(headers.get("x-custom-header")).toBe("custom-value")
        expect(headers.get("x-opencode-directory")).toBe(encodeURIComponent(test.directory))
      }
    }),
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      const result = yield* mcp.add("test-server-no-oauth", {
        type: "remote",
        url: server.url,
        oauth: false,
        headers: {
          Authorization: "Bearer test-token",
        },
      })

      expect(result.status).toMatchObject({ "test-server-no-oauth": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.get("authorization")).toBe("Bearer test-token")
        expect(headers.get("x-opencode-directory")).toBe(encodeURIComponent(test.directory))
      }
    }),
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      const result = yield* mcp.add("test-server-no-headers", {
        type: "remote",
        url: server.url,
      })

      expect(result.status).toMatchObject({ "test-server-no-headers": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        expect(headers.has("authorization")).toBe(false)
        expect(headers.has("x-custom-header")).toBe(false)
        expect(headers.get("x-opencode-directory")).toBe(encodeURIComponent(test.directory))
      }
    }),
  )

  it.instance("directory is encoded once into an ASCII-safe header", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      const directory = path.join(test.directory, "中文项目 %2F")
      yield* Effect.promise(() => fs.mkdir(directory))

      const result = yield* mcp
        .add("test-server-unicode-directory", {
          type: "remote",
          url: server.url,
          oauth: false,
          headers: {
            "x-opencode-directory": "/wrong/directory",
          },
        })
        .pipe(provideInstanceEffect(directory))

      expect(result.status).toMatchObject({ "test-server-unicode-directory": { status: "connected" } })
      expect(server.requests.length).toBeGreaterThan(0)
      for (const headers of server.requests) {
        const value = headers.get("x-opencode-directory")
        expect(value).toBe(encodeURIComponent(directory))
        expect(value).toMatch(/^[\x20-\x7E]+$/)
        expect(decodeURIComponent(value!)).toBe(directory)
      }
    }),
  )
})
