import type { PluginStorageRecord, PluginStorageScope } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { Storage } from "@/storage/storage"

const SCOPES: readonly PluginStorageScope[] = ["global", "server", "workspace", "session"]

function assertScope(scope: PluginStorageScope) {
  if (!SCOPES.includes(scope)) throw new TypeError(`invalid plugin storage scope: "${scope}"`)
}

function segments(value: string, label: string) {
  const parts = value.split("/")
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw new TypeError(`invalid plugin storage ${label}: "${value}"`)
  }
  return parts
}

// Security: a plugin id MUST occupy exactly one path segment. Splitting it on
// "/" lets ids like "a/global/b" expand into scope/key positions and collide
// with or escape another plugin's namespace. encodeURIComponent never emits "/".
function pluginSegment(pluginID: string) {
  const encoded = encodeURIComponent(pluginID)
  if (encoded === "" || encoded === "." || encoded === "..")
    throw new TypeError(`invalid plugin storage pluginID: "${pluginID}"`)
  return encoded
}

export function scoped(storage: Storage.Interface, pluginID: string) {
  const base = ["plugin", pluginSegment(pluginID)]
  const keyFor = (scope: PluginStorageScope, key: string) => {
    assertScope(scope)
    return [...base, scope, ...segments(key, "key")]
  }
  return {
    get: (scope: PluginStorageScope, key: string) =>
      Effect.suspend(() =>
        storage
          .read<PluginStorageRecord>(keyFor(scope, key))
          .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined))),
      ),
    put: (scope: PluginStorageScope, key: string, record: PluginStorageRecord) =>
      Effect.suspend(() => storage.write(keyFor(scope, key), record)),
    delete: (scope: PluginStorageScope, key: string) => Effect.suspend(() => storage.remove(keyFor(scope, key))),
    list: (scope: PluginStorageScope) =>
      Effect.suspend(() => {
        assertScope(scope)
        const prefix = [...base, scope]
        return storage
          .list(prefix)
          .pipe(Effect.map((keys) => keys.map((key) => key.slice(prefix.length).join("/")).toSorted()))
      }),
  }
}

export * as PluginStorage from "./storage"
