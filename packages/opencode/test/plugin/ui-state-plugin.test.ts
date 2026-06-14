import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import type { PluginRouteHandler, PluginStorage, PluginStorageRecord, PluginStorageScope } from "@opencode-ai/plugin"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Storage } from "@/storage/storage"
import { PluginRoute } from "../../src/plugin/route"
import { PluginStorage as PluginStorageCore } from "../../src/plugin/storage"
import { WebState } from "../../src/plugin/web-state"
import { testEffect } from "../lib/effect"

// Faithful in-memory double of the public PluginStorage seam: namespaced by scope,
// metadata preserved verbatim, no conflict policy of its own (the plugin owns LWW).
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

function deferred() {
  const result = {
    promise: Promise.resolve(),
    resolve: () => {},
  }
  result.promise = new Promise<void>((resolve) => {
    result.resolve = resolve
  })
  return result
}

const url = (group: string) => `http://localhost/api/plugin/${WebState.ID}${WebState.STATE_PREFIX}${group}`

function getReq(group: string) {
  return new Request(url(group))
}

function putReq(group: string, body: unknown) {
  return new Request(url(group), {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

async function call(handler: PluginRouteHandler | undefined, request: Request) {
  expect(handler).toBeDefined()
  const response = await handler!(request)
  const body = await response.json().catch(() => undefined)
  return { status: response.status, body }
}

// Register the plugin through the real route seam so lookups resolve handlers
// exactly as the HTTP dispatch would, and look them up per (scope, method, path).
function setup(scope: string, worktree: string, storage = makeMemoryStorage()) {
  WebState.register({
    experimental_route: PluginRoute.registrar(scope, WebState.ID),
    experimental_storage: storage,
    worktree,
  })
  return {
    storage,
    get: (group: string) => PluginRoute.lookup(scope, WebState.ID, "GET", WebState.STATE_PREFIX + group),
    put: (group: string) => PluginRoute.lookup(scope, WebState.ID, "PUT", WebState.STATE_PREFIX + group),
  }
}

afterEach(() => PluginRoute.reset())

describe("ui-state plugin endpoints", () => {
  test("registers GET and PUT handlers for every v1 group", () => {
    const api = setup("/inst", "/ws")
    for (const group of WebState.GROUPS) {
      expect(api.get(group.id)).toBeDefined()
      expect(api.put(group.id)).toBeDefined()
    }
  })

  test("does not register a route for an unknown group", () => {
    const api = setup("/inst", "/ws")
    expect(api.get("not-a-group")).toBeUndefined()
    expect(api.put("not-a-group")).toBeUndefined()
  })

  test("returns a default empty record when no record exists", async () => {
    const api = setup("/inst", "/ws")
    const result = await call(api.get("server"), getReq("server"))
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ value: null, version: "v1", updated_at: 0 })
  })

  test("round-trips a value through PUT then GET", async () => {
    const api = setup("/inst", "/ws")
    const record = { value: { list: ["p1"], lastProject: "p1" }, version: "v1", updated_at: 100 }
    const put = await call(api.put("server"), putReq("server", record))
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ applied: true, ...record })

    const get = await call(api.get("server"), getReq("server"))
    expect(get.body).toEqual(record)
  })

  test("rejects a stale write and preserves the newer record", async () => {
    const api = setup("/inst", "/ws")
    await call(api.put("layout"), putReq("layout", { value: { open: true }, version: "v1", updated_at: 100 }))

    const stale = await call(api.put("layout"), putReq("layout", { value: { open: false }, version: "v1", updated_at: 50 }))
    expect(stale.body).toEqual({ applied: false, value: { open: true }, version: "v1", updated_at: 100 })

    const get = await call(api.get("layout"), getReq("layout"))
    expect(get.body).toEqual({ value: { open: true }, version: "v1", updated_at: 100 })
  })

  test("treats an equal updated_at as a stale write", async () => {
    const api = setup("/inst", "/ws")
    await call(api.put("model"), putReq("model", { value: { user: "a" }, version: "v1", updated_at: 100 }))

    const equal = await call(api.put("model"), putReq("model", { value: { user: "b" }, version: "v1", updated_at: 100 }))
    expect(equal.body).toEqual({ applied: false, value: { user: "a" }, version: "v1", updated_at: 100 })
  })

  test("applies a strictly newer write over the stored record", async () => {
    const api = setup("/inst", "/ws")
    await call(api.put("model"), putReq("model", { value: { user: "a" }, version: "v1", updated_at: 100 }))

    const newer = await call(api.put("model"), putReq("model", { value: { user: "b" }, version: "v1", updated_at: 200 }))
    expect(newer.body).toEqual({ applied: true, value: { user: "b" }, version: "v1", updated_at: 200 })

    const get = await call(api.get("model"), getReq("model"))
    expect(get.body).toEqual({ value: { user: "b" }, version: "v1", updated_at: 200 })
  })

  test("serializes concurrent last-write-wins writes by explicit updated_at", async () => {
    const stale = deferred()
    const newer = deferred()
    const base = makeMemoryStorage()
    const storage: PluginStorage = {
      ...base,
      async put(scope, key, record) {
        if (record.metadata?.updated_at === 100) await stale.promise
        if (record.metadata?.updated_at === 200) await newer.promise
        await base.put(scope, key, record)
      },
    }
    const api = setup("/inst", "/ws", storage)

    const staleWrite = call(api.put("layout"), putReq("layout", { value: { v: 1 }, version: "v1", updated_at: 100 }))
    await Promise.resolve()
    const newerWrite = call(api.put("layout"), putReq("layout", { value: { v: 2 }, version: "v1", updated_at: 200 }))
    await Promise.resolve()

    newer.resolve()
    await Promise.resolve()
    stale.resolve()

    await Promise.all([staleWrite, newerWrite])
    const get = await call(api.get("layout"), getReq("layout"))
    expect(get.body).toEqual({ value: { v: 2 }, version: "v1", updated_at: 200 })
  })

  test("round-trips a distinct value for every v1 group", async () => {
    const api = setup("/inst", "/ws")
    for (const [index, group] of WebState.GROUPS.entries()) {
      const record = { value: { group: group.id, n: index }, version: "v1", updated_at: index + 1 }
      const put = await call(api.put(group.id), putReq(group.id, record))
      expect(put.body).toEqual({ applied: true, ...record })
      const get = await call(api.get(group.id), getReq(group.id))
      expect(get.body).toEqual(record)
    }
  })

  test("rejects a body that is not valid JSON", async () => {
    const api = setup("/inst", "/ws")
    const result = await call(api.put("server"), putReq("server", "{ not json"))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: "invalid_json" })
  })

  test("rejects a record missing version or updated_at", async () => {
    const api = setup("/inst", "/ws")
    expect((await call(api.put("server"), putReq("server", { value: 1, updated_at: 1 }))).status).toBe(400)
    expect((await call(api.put("server"), putReq("server", { value: 1, version: "v1" }))).status).toBe(400)
    expect((await call(api.put("server"), putReq("server", { version: "v1", updated_at: 1 }))).status).toBe(400)
    expect((await call(api.put("server"), putReq("server", { value: 1, version: "v1", updated_at: "x" }))).status).toBe(
      400,
    )
  })

  test("isolates workspace groups per worktree while sharing global groups", async () => {
    const storage = makeMemoryStorage()
    WebState.register({
      experimental_route: PluginRoute.registrar("/inst/a", WebState.ID),
      experimental_storage: storage,
      worktree: "/ws/a",
    })
    WebState.register({
      experimental_route: PluginRoute.registrar("/inst/b", WebState.ID),
      experimental_storage: storage,
      worktree: "/ws/b",
    })
    const workspace = "workspace:model-selection"
    const lookup = (inst: string, method: string, group: string) =>
      PluginRoute.lookup(inst, WebState.ID, method, WebState.STATE_PREFIX + group)

    await call(lookup("/inst/a", "PUT", workspace), putReq(workspace, { value: { m: "a" }, version: "v1", updated_at: 100 }))
    expect((await call(lookup("/inst/a", "GET", workspace), getReq(workspace))).body).toEqual({
      value: { m: "a" },
      version: "v1",
      updated_at: 100,
    })
    expect((await call(lookup("/inst/b", "GET", workspace), getReq(workspace))).body).toEqual({
      value: null,
      version: "v1",
      updated_at: 0,
    })

    await call(lookup("/inst/a", "PUT", "server"), putReq("server", { value: { s: "shared" }, version: "v1", updated_at: 100 }))
    expect((await call(lookup("/inst/b", "GET", "server"), getReq("server"))).body).toEqual({
      value: { s: "shared" },
      version: "v1",
      updated_at: 100,
    })
  })
})

// Integration: drive the plugin over the REAL plugin storage seam (Task 2) backed
// by the real Storage service, proving the persistence path is genuine end-to-end.
const dir = path.join(Global.Path.data, "storage")
const it = testEffect(Layer.mergeAll(Storage.defaultLayer, AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer))

const realSetup = Effect.fnUntraced(function* (scope: string, worktree: string) {
  const fs = yield* AppFileSystem.Service
  const storage = yield* Storage.Service
  const pluginID = `plugin-web-state-${crypto.randomUUID()}`
  yield* Effect.addFinalizer(() =>
    fs.remove(path.join(dir, "plugin", pluginID), { recursive: true, force: true }).pipe(Effect.ignore),
  )
  const core = PluginStorageCore.scoped(storage, pluginID)
  const bound: PluginStorage = {
    get: (s, k) => Effect.runPromise(core.get(s, k)),
    put: (s, k, record) => Effect.runPromise(core.put(s, k, record)),
    delete: (s, k) => Effect.runPromise(core.delete(s, k)),
    list: (s) => Effect.runPromise(core.list(s)),
  }
  WebState.register({ experimental_route: PluginRoute.registrar(scope, WebState.ID), experimental_storage: bound, worktree })
  return {
    get: (group: string) => PluginRoute.lookup(scope, WebState.ID, "GET", WebState.STATE_PREFIX + group),
    put: (group: string) => PluginRoute.lookup(scope, WebState.ID, "PUT", WebState.STATE_PREFIX + group),
  }
})

describe("ui-state plugin over real storage seam", () => {
  it.live("round-trips a record through the real plugin storage seam", () =>
    Effect.gen(function* () {
      const api = yield* realSetup("/inst", "/ws")
      const record = { value: { list: ["p1"] }, version: "v1", updated_at: 100 }
      const put = yield* Effect.promise(() => call(api.put("server"), putReq("server", record)))
      expect(put.body).toEqual({ applied: true, ...record })
      const get = yield* Effect.promise(() => call(api.get("server"), getReq("server")))
      expect(get.body).toEqual(record)
    }),
  )

  it.live("applies last-write-wins through the real storage seam", () =>
    Effect.gen(function* () {
      const api = yield* realSetup("/inst", "/ws")
      yield* Effect.promise(() => call(api.put("layout"), putReq("layout", { value: { v: 2 }, version: "v1", updated_at: 200 })))
      const stale = yield* Effect.promise(() =>
        call(api.put("layout"), putReq("layout", { value: { v: 1 }, version: "v1", updated_at: 100 })),
      )
      expect(stale.body).toEqual({ applied: false, value: { v: 2 }, version: "v1", updated_at: 200 })
      const get = yield* Effect.promise(() => call(api.get("layout"), getReq("layout")))
      expect(get.body).toEqual({ value: { v: 2 }, version: "v1", updated_at: 200 })
    }),
  )
})
