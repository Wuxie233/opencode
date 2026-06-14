// Reusable, isolated test fixtures for the server-side web-state plugin work.
//
// These are in-memory test doubles only. They do NOT implement the real plugin
// HTTP route seam (Task 1) or the scoped plugin JSON/KV storage API (Task 2).
// They exist so route-seam, plugin-storage, and UI-state plugin tests can share
// isolated setup instead of re-declaring a route registry and a namespaced KV
// store per file. Each fixture instance owns its own state; create a fresh one
// per test to keep state isolated per plugin ID and avoid cross-test leakage.

export type RouteResponse = {
  status: number
  body?: unknown
}

export type RouteHandler = (request: { method: string; path: string; body?: unknown }) => RouteResponse | Promise<RouteResponse>

// In-memory plugin route registry double. Mirrors the intended seam contract:
// plugins register handlers under `/api/plugin/<pluginID>/<path>` and unknown
// paths return a 404 without invoking any handler.
export class PluginRouteFixture {
  private routes = new Map<string, RouteHandler>()

  private key(method: string, pluginID: string, path: string) {
    return `${method.toUpperCase()} ${pluginID}\u0000${normalizePath(path)}`
  }

  register(pluginID: string, method: string, path: string, handler: RouteHandler) {
    this.routes.set(this.key(method, pluginID, path), handler)
  }

  // Dispatch a request the way the real server handler would: route to the
  // registered plugin handler, or return a 404 not-found response when the
  // plugin or path is unknown.
  async dispatch(method: string, pluginID: string, path: string, body?: unknown): Promise<RouteResponse> {
    const handler = this.routes.get(this.key(method, pluginID, path))
    if (!handler) return { status: 404, body: { error: "not_found" } }
    return handler({ method: method.toUpperCase(), path: normalizePath(path), body })
  }

  clear() {
    this.routes.clear()
  }
}

function normalizePath(path: string) {
  if (!path.startsWith("/")) return "/" + path
  return path
}

export type StoredRecord = {
  value: unknown
  metadata?: Record<string, unknown>
}

// In-memory scoped plugin KV storage double. Namespaces by plugin ID and logical
// scope so plugin A cannot read, list, or overwrite plugin B keys. Preserves
// plugin-supplied metadata verbatim and applies no conflict policy of its own
// (last-write-wins / `updated_at` belongs to the plugin layer, not storage).
export type StorageScope = "global" | "server" | "workspace" | "session"

export class PluginStorageFixture {
  private store = new Map<string, StoredRecord>()
  readonly calls = { get: 0, put: 0, delete: 0, list: 0 }

  private prefix(pluginID: string, scope: StorageScope) {
    return `plugin/${pluginID}/${scope}/`
  }

  private key(pluginID: string, scope: StorageScope, key: string) {
    return this.prefix(pluginID, scope) + key
  }

  get(pluginID: string, scope: StorageScope, key: string): StoredRecord | undefined {
    this.calls.get += 1
    const record = this.store.get(this.key(pluginID, scope, key))
    return record ? clone(record) : undefined
  }

  put(pluginID: string, scope: StorageScope, key: string, record: StoredRecord) {
    this.calls.put += 1
    this.store.set(this.key(pluginID, scope, key), clone(record))
  }

  delete(pluginID: string, scope: StorageScope, key: string) {
    this.calls.delete += 1
    this.store.delete(this.key(pluginID, scope, key))
  }

  // List only the keys owned by this plugin + scope, with the namespace prefix
  // stripped, so callers never see other plugins' keys.
  list(pluginID: string, scope: StorageScope): string[] {
    this.calls.list += 1
    const prefix = this.prefix(pluginID, scope)
    return Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .toSorted()
  }

  clear() {
    this.store.clear()
  }
}

function clone(record: StoredRecord): StoredRecord {
  return JSON.parse(JSON.stringify(record)) as StoredRecord
}
