import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput, PluginStorage, PluginStorageRecord, PluginStorageScope } from "@opencode-ai/plugin"
import { HttpRouter } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import { PluginRoute } from "../../src/plugin/route"
import { WebState } from "../../src/plugin/web-state"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceRoutes } from "../../src/server/routes/instance"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const originalHttpApi = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  const handler = HttpRouter.toWebHandler(ExperimentalHttpApiServer.routes, { disableLogger: true }).handler
  return {
    request(input: string, init?: RequestInit) {
      return handler(new Request(new URL(input, "http://localhost"), init), ExperimentalHttpApiServer.context)
    },
  }
}

function stableHonoApp() {
  return InstanceRoutes(() => new Response(null, { status: 501 }) as never)
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
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = originalHttpApi
  PluginRoute.reset()
  await disposeAllInstances()
  await resetDatabase()
})

describe("plugin HTTP route seam", () => {
  test("dispatches a plugin route registered through experimental_route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app()
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

    const response = await server.request("/api/plugin/test-plugin/health", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ ok: true })
  })

  test("returns not found for unknown plugin routes without invoking handlers", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app()
    let invoked = false
    runPlugin(tmp.path, "test-plugin", (input) =>
      input.experimental_route.register("GET", "/health", () => {
        invoked = true
        return new Response(null, { status: 200 })
      }),
    )
    const headers = { "x-opencode-directory": tmp.path }

    const unknownPath = await server.request("/api/plugin/test-plugin/missing", { headers })
    expect(unknownPath.status).toBe(404)

    const unknownPlugin = await server.request("/api/plugin/other-plugin/health", { headers })
    expect(unknownPlugin.status).toBe(404)

    const wrongMethod = await server.request("/api/plugin/test-plugin/health", { method: "POST", headers })
    expect(wrongMethod.status).toBe(404)

    expect(invoked).toBe(false)
  })

  test("routes the same plugin id to the handler of the requested instance", async () => {
    await using tmpA = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using tmpB = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app()

    runPlugin(tmpA.path, "same", (input) =>
      input.experimental_route.register("GET", "/health", () => new Response("A", { status: 200 })),
    )
    runPlugin(tmpB.path, "same", (input) =>
      input.experimental_route.register("GET", "/health", () => new Response("B", { status: 200 })),
    )

    const fromA = await server.request("/api/plugin/same/health", { headers: { "x-opencode-directory": tmpA.path } })
    expect(fromA.status).toBe(200)
    expect(await fromA.text()).toBe("A")

    const fromB = await server.request("/api/plugin/same/health", { headers: { "x-opencode-directory": tmpB.path } })
    expect(fromB.status).toBe(200)
    expect(await fromB.text()).toBe("B")
  })

  test("stable Hono bridge scopes plugin routes to x-opencode-directory", async () => {
    await using unrelated = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using target = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const storage = makeMemoryStorage()
    const server = stableHonoApp()
    WebState.register({
      experimental_route: PluginRoute.registrar(unrelated.path, WebState.ID),
      experimental_storage: storage,
      worktree: unrelated.path,
    })
    WebState.register({
      experimental_route: PluginRoute.registrar(target.path, WebState.ID),
      experimental_storage: storage,
      worktree: target.path,
    })
    const path = `/api/plugin/${WebState.ID}${WebState.STATE_PREFIX}workspace:model-selection`

    await WithInstance.provide({
      directory: unrelated.path,
      async fn() {
        const staleSeed = await server.request(path, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-opencode-directory": unrelated.path },
          body: JSON.stringify({ value: { session: { unrelated: true } }, version: "v1", updated_at: 1000 }),
        })
        expect(await staleSeed.json()).toMatchObject({ applied: true })

        const targetWrite = await server.request(path, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-opencode-directory": target.path },
          body: JSON.stringify({ value: { session: { target: true } }, version: "v1", updated_at: 100 }),
        })
        expect(await targetWrite.json()).toEqual({
          applied: true,
          value: { session: { target: true } },
          version: "v1",
          updated_at: 100,
        })

        const targetRead = await server.request(path, { headers: { "x-opencode-directory": target.path } })
        expect(await targetRead.json()).toEqual({
          value: { session: { target: true } },
          version: "v1",
          updated_at: 100,
        })
      },
    })
  })
})
