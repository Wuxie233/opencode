import { describe, expect, test } from "bun:test"
import { PluginRouteFixture, PluginStorageFixture } from "./web-state-fixture"

describe("PluginRouteFixture", () => {
  test("dispatches registered plugin route", async () => {
    const routes = new PluginRouteFixture()
    routes.register("opencode.web-state", "GET", "/health", () => ({ status: 200, body: { ok: true } }))
    const res = await routes.dispatch("GET", "opencode.web-state", "/health")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test("unknown plugin route returns 404 without invoking a handler", async () => {
    const routes = new PluginRouteFixture()
    const res = await routes.dispatch("GET", "missing", "/health")
    expect(res.status).toBe(404)
  })

  test("instances are isolated", async () => {
    const a = new PluginRouteFixture()
    const b = new PluginRouteFixture()
    a.register("p", "GET", "/x", () => ({ status: 200 }))
    expect((await b.dispatch("GET", "p", "/x")).status).toBe(404)
  })
})

describe("PluginStorageFixture", () => {
  test("round-trips JSON records and lists scoped keys", () => {
    const storage = new PluginStorageFixture()
    storage.put("opencode.web-state", "global", "layout", { value: { tab: 1 } })
    expect(storage.get("opencode.web-state", "global", "layout")).toEqual({ value: { tab: 1 } })
    expect(storage.list("opencode.web-state", "global")).toEqual(["layout"])
    storage.delete("opencode.web-state", "global", "layout")
    expect(storage.get("opencode.web-state", "global", "layout")).toBeUndefined()
  })

  test("preserves plugin-supplied metadata verbatim", () => {
    const storage = new PluginStorageFixture()
    storage.put("p", "server", "k", { value: 1, metadata: { updated_at: 42, version: "v1" } })
    expect(storage.get("p", "server", "k")?.metadata).toEqual({ updated_at: 42, version: "v1" })
  })

  test("namespaces isolate plugins and scopes", () => {
    const storage = new PluginStorageFixture()
    storage.put("a", "global", "k", { value: "a" })
    storage.put("b", "global", "k", { value: "b" })
    storage.put("a", "session", "k", { value: "a-session" })
    expect(storage.get("b", "global", "k")?.value).toBe("b")
    expect(storage.list("b", "global")).toEqual(["k"])
    expect(storage.list("a", "global")).toEqual(["k"])
    expect(storage.list("a", "session")).toEqual(["k"])
  })
})
