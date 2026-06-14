import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { PluginRoute } from "../../src/plugin/route"

// A server plugin only receives a PluginInput; it registers HTTP handlers through
// the public experimental_route seam, which binds each handler to BOTH the owning
// plugin id and the instance directory it was loaded for (`scope` stands in for
// that per-instance directory). Exercising registration this way proves the public
// seam and the per-instance scoping, not just the internal registry. This test
// imports only the dependency-free route registry, so it runs without the full
// server/plugin bootstrap.
function runPlugin(
  scope: string,
  pluginID: string,
  server: (input: Pick<PluginInput, "experimental_route">) => void,
) {
  server({ experimental_route: PluginRoute.registrar(scope, pluginID) })
}

afterEach(() => PluginRoute.reset())

describe("plugin route registry seam", () => {
  test("experimental_route.register binds a handler to the owning plugin id and scope", () => {
    const handler = () => new Response("ok")
    runPlugin("/project/a", "test-plugin", (input) => input.experimental_route.register("GET", "/health", handler))

    expect(PluginRoute.lookup("/project/a", "test-plugin", "GET", "/health")).toBe(handler)
    expect(PluginRoute.parse("/api/plugin/test-plugin/health")).toEqual({ pluginID: "test-plugin", path: "/health" })
  })

  // Regression for the instance-isolation bug: the same plugin id + method + path
  // loaded for two directories must keep two distinct handlers. A registry keyed
  // only by pluginID+method+path overwrites, so both scopes resolve to the
  // last-registered handler.
  test("isolates the same plugin id + path registered under different instance scopes", () => {
    const a = () => new Response("a")
    const b = () => new Response("b")
    runPlugin("/project/a", "same", (input) => input.experimental_route.register("GET", "/health", a))
    runPlugin("/project/b", "same", (input) => input.experimental_route.register("GET", "/health", b))

    expect(PluginRoute.lookup("/project/a", "same", "GET", "/health")).toBe(a)
    expect(PluginRoute.lookup("/project/b", "same", "GET", "/health")).toBe(b)
  })

  test("does not register under another scope, plugin id, path, or method", () => {
    const handler = () => new Response("ok")
    runPlugin("/project/a", "test-plugin", (input) => input.experimental_route.register("GET", "/health", handler))

    expect(PluginRoute.lookup("/project/b", "test-plugin", "GET", "/health")).toBeUndefined()
    expect(PluginRoute.lookup("/project/a", "other-plugin", "GET", "/health")).toBeUndefined()
    expect(PluginRoute.lookup("/project/a", "test-plugin", "GET", "/missing")).toBeUndefined()
    expect(PluginRoute.lookup("/project/a", "test-plugin", "POST", "/health")).toBeUndefined()
  })

  test("isolates handlers registered by different plugins on the same path and scope", () => {
    const a = () => new Response("a")
    const b = () => new Response("b")
    runPlugin("/project/a", "plugin-a", (input) => input.experimental_route.register("GET", "/health", a))
    runPlugin("/project/a", "plugin-b", (input) => input.experimental_route.register("GET", "/health", b))

    expect(PluginRoute.lookup("/project/a", "plugin-a", "GET", "/health")).toBe(a)
    expect(PluginRoute.lookup("/project/a", "plugin-b", "GET", "/health")).toBe(b)
  })

  test("normalizes a registered path so it is reachable with a leading slash", () => {
    const handler = () => new Response("ok")
    runPlugin("/project/a", "test-plugin", (input) => input.experimental_route.register("GET", "health", handler))

    expect(PluginRoute.lookup("/project/a", "test-plugin", "GET", "/health")).toBe(handler)
  })

  test("parse rejects paths outside the reserved plugin namespace", () => {
    expect(PluginRoute.parse("/api/session/foo")).toBeUndefined()
    expect(PluginRoute.parse("/api/plugin/")).toBeUndefined()
  })
})
