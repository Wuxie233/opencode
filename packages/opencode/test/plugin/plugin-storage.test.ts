import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Storage } from "@/storage/storage"
import { PluginStorage } from "../../src/plugin/storage"
import { testEffect } from "../lib/effect"

const dir = path.join(Global.Path.data, "storage")

const it = testEffect(Layer.mergeAll(Storage.defaultLayer, AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer))

const setup = Effect.fnUntraced(function* () {
  const fs = yield* AppFileSystem.Service
  const storage = yield* Storage.Service
  const pluginID = `plugin-test-${crypto.randomUUID()}`
  yield* Effect.addFinalizer(() =>
    fs.remove(path.join(dir, "plugin", pluginID), { recursive: true, force: true }).pipe(Effect.ignore),
  )
  return { storage, pluginID }
})

describe("PluginStorage.scoped", () => {
  it.live("round-trips JSON values and preserves metadata verbatim", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const api = PluginStorage.scoped(storage, pluginID)
      const record = { value: { tab: 1, items: ["a", "b"] }, metadata: { updated_at: 42, version: "v1" } }
      yield* api.put("global", "layout", record)
      expect(yield* api.get("global", "layout")).toEqual(record)
    }),
  )

  it.live("returns undefined for missing keys and after delete", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const api = PluginStorage.scoped(storage, pluginID)
      expect(yield* api.get("server", "missing")).toBeUndefined()
      yield* api.put("server", "k", { value: 1 })
      expect(yield* api.get("server", "k")).toEqual({ value: 1 })
      yield* api.delete("server", "k")
      expect(yield* api.get("server", "k")).toBeUndefined()
      yield* api.delete("server", "k")
    }),
  )

  it.live("lists only keys owned by the plugin and scope, prefix stripped and sorted", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const api = PluginStorage.scoped(storage, pluginID)
      yield* api.put("global", "b", { value: 1 })
      yield* api.put("global", "a", { value: 2 })
      yield* api.put("session", "s", { value: 3 })
      expect(yield* api.list("global")).toEqual(["a", "b"])
      expect(yield* api.list("session")).toEqual(["s"])
      expect(yield* api.list("workspace")).toEqual([])
    }),
  )

  it.live("isolates reads, lists, writes, and deletes between plugins", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const { pluginID: otherID } = yield* setup()
      const a = PluginStorage.scoped(storage, pluginID)
      const b = PluginStorage.scoped(storage, otherID)
      yield* a.put("global", "k", { value: "a" })
      yield* b.put("global", "k", { value: "b" })
      expect((yield* a.get("global", "k"))?.value).toBe("a")
      expect((yield* b.get("global", "k"))?.value).toBe("b")
      expect(yield* a.list("global")).toEqual(["k"])
      expect(yield* b.list("global")).toEqual(["k"])
      yield* b.delete("global", "k")
      expect((yield* a.get("global", "k"))?.value).toBe("a")
      expect(yield* b.get("global", "k")).toBeUndefined()
    }),
  )

  it.live("isolates path-shaped plugin ids from colliding with another plugin's scope/key", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const fs = yield* AppFileSystem.Service
      const collidingID = `${pluginID}/global/b`
      yield* Effect.addFinalizer(() =>
        fs
          .remove(path.join(dir, "plugin", encodeURIComponent(collidingID)), { recursive: true, force: true })
          .pipe(Effect.ignore),
      )
      const a = PluginStorage.scoped(storage, pluginID)
      const b = PluginStorage.scoped(storage, collidingID)
      yield* a.put("global", "b/global/k", { value: "a" })
      yield* b.put("global", "k", { value: "b" })
      expect((yield* a.get("global", "b/global/k"))?.value).toBe("a")
      expect((yield* b.get("global", "k"))?.value).toBe("b")
      expect(yield* a.list("global")).toEqual(["b/global/k"])
      expect(yield* b.list("global")).toEqual(["k"])
    }),
  )

  it.live("stores updated_at verbatim without applying any conflict policy", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const api = PluginStorage.scoped(storage, pluginID)
      yield* api.put("global", "k", { value: "new", metadata: { updated_at: 100 } })
      yield* api.put("global", "k", { value: "old", metadata: { updated_at: 1 } })
      expect(yield* api.get("global", "k")).toEqual({ value: "old", metadata: { updated_at: 1 } })
    }),
  )

  it.live("rejects path-traversal keys to preserve namespace isolation", () =>
    Effect.gen(function* () {
      const { storage, pluginID } = yield* setup()
      const api = PluginStorage.scoped(storage, pluginID)
      const exit = yield* Effect.exit(api.get("global", "../../escape"))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
