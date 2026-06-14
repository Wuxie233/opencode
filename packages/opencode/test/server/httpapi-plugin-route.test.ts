import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput, PluginStorage, PluginStorageRecord, PluginStorageScope } from "@opencode-ai/plugin"
import { Server } from "../../src/server/server"
import { PluginRoute } from "../../src/plugin/route"
import { WebState } from "../../src/plugin/web-state"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Drive the production server app (the same route tree createRoutes() assembles).
// The raw plugin route is merged into that tree and resolves the routed instance
// directory through the workspace-routing + instance-context middleware, so an
// `x-opencode-directory` header selects which instance scope a plugin route was
// registered for.
function app() {
  return Server.Default().app
}

function makeMemoryStorage(): PluginStorage {
  const store = new Map<string, PluginStorageRecord>()
  const id = (scope: PluginStorageScope, key: string) => `${scope}\u0000${key}`
  return {
    async get(scope, key) {
      const record = store.get(id(scope, key))
      return record ? structuredClone(record) : undefined
    },
    async put(scope, key, record) {
      store.set(id(scope, key), structuredClone(record))
    },
    async delete(scope, key) {
      store.delete(id(scope, key))
    },
    async list(scope) {
      const prefix = `${scope}\u0000`
      return Array.from(store.keys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .toSorted()
    },
  }
}

// Register exactly the way a server plugin does: it receives a PluginInput and
// calls input.experimental_route.register(...), which binds the handler to the
// plugin's own id and the instance directory it was loaded for. `scope` is that
// directory (production passes ctx.directory). Going through the public seam (not
// PluginRoute.register directly) is what proves a real plugin can register a
// routable handler that the dispatch resolves per routed instance.
function runPlugin(
  scope: string,
  pluginID: string,
  server: (input: Pick<PluginInput, "experimental_route">) => void,
) {
  server({ experimental_route: PluginRoute.registrar(scope, pluginID) })
}

afterEach(async () => {
  PluginRoute.reset()
  await disposeAllInstances()
  await resetDatabase()
})

describe("plugin HTTP route seam", () => {
  test("dispatches a plugin route registered through experimental_route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    runPlugin(tmp.path, "test-plugin", (input) =>
      input.experimental_route.register(
        "GET",
        "/health",
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    const response = await app().request("/api/plugin/test-plugin/health", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ ok: true })
  })

  test("returns not found for unknown plugin routes without invoking handlers", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    let invoked = false
    runPlugin(tmp.path, "test-plugin", (input) =>
      input.experimental_route.register("GET", "/health", () => {
        invoked = true
        return new Response(null, { status: 200 })
      }),
    )
    const headers = { "x-opencode-directory": tmp.path }

    const unknownPath = await app().request("/api/plugin/test-plugin/missing", { headers })
    expect(unknownPath.status).toBe(404)

    const unknownPlugin = await app().request("/api/plugin/other-plugin/health", { headers })
    expect(unknownPlugin.status).toBe(404)

    const wrongMethod = await app().request("/api/plugin/test-plugin/health", { method: "POST", headers })
    expect(wrongMethod.status).toBe(404)

    expect(invoked).toBe(false)
  })

  test("routes the same plugin id to the handler of the requested instance", async () => {
    await using tmpA = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using tmpB = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    runPlugin(tmpA.path, "same", (input) =>
      input.experimental_route.register("GET", "/health", () => new Response("A", { status: 200 })),
    )
    runPlugin(tmpB.path, "same", (input) =>
      input.experimental_route.register("GET", "/health", () => new Response("B", { status: 200 })),
    )

    const fromA = await app().request("/api/plugin/same/health", { headers: { "x-opencode-directory": tmpA.path } })
    expect(fromA.status).toBe(200)
    expect(await fromA.text()).toBe("A")

    const fromB = await app().request("/api/plugin/same/health", { headers: { "x-opencode-directory": tmpB.path } })
    expect(fromB.status).toBe(200)
    expect(await fromB.text()).toBe("B")
  })

  test("dispatches the web-state plugin route for the routed instance", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const storage = makeMemoryStorage()
    WebState.register({
      experimental_route: PluginRoute.registrar(tmp.path, WebState.ID),
      experimental_storage: storage,
      worktree: tmp.path,
    })
    const url = `/api/plugin/${WebState.ID}${WebState.STATE_PREFIX}workspace:model-selection`
    const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }

    const missing = await app().request(url, { headers: { "x-opencode-directory": tmp.path } })
    expect(missing.status).toBe(200)
    expect(await missing.json()).toEqual({ value: null, version: "v1", updated_at: 0 })

    const write = await app().request(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: { m: "selected" }, version: "v1", updated_at: 100 }),
    })
    expect(write.status).toBe(200)
    expect(await write.json()).toEqual({ applied: true, value: { m: "selected" }, version: "v1", updated_at: 100 })

    const read = await app().request(url, { headers: { "x-opencode-directory": tmp.path } })
    expect(await read.json()).toEqual({ value: { m: "selected" }, version: "v1", updated_at: 100 })
  })
})
