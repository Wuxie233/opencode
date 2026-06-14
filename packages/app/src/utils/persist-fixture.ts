// Reusable, isolated test fixtures for server-backed web-state persistence tests.
//
// This module is intentionally test-only: nothing in the app imports it, so it is
// never bundled into production. It exists so persistence tests (server hydrate,
// local-to-server migration, settings sync, fallback) can share setup instead of
// re-declaring an in-memory localStorage double and a server-state mock per file.
//
// Nothing here implements the real persistence adapter, route seam, or plugin
// storage API. These are test doubles only.

// In-memory `Storage` double mirroring the localStorage behavior used by persist.ts.
// Each instance is isolated; create a fresh one per test (or call `clear()` in beforeEach)
// to avoid cross-test leakage. Keys prefixed with "opencode.quota" throw a
// QuotaExceededError on set; keys prefixed with "opencode.throw" throw on every op,
// matching the failure-injection contract the existing persist tests rely on.
export class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  reset() {
    this.values.clear()
    this.events.length = 0
    this.calls.get = 0
    this.calls.set = 0
    this.calls.remove = 0
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("opencode.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("opencode.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

// Install a MemoryStorage as the global `localStorage` for the current test.
// Returns the storage so callers can assert on it. Configurable so a later test
// can replace it.
export function installLocalStorage(storage: MemoryStorage = new MemoryStorage()) {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
  return storage
}

export type ServerRecord = {
  value: unknown
  // Contract version string (e.g. "v1") owned by the UI-state contract. The LWW
  // conflict policy below intentionally does NOT use this; it uses numeric
  // `updated_at` only.
  version: string
  updated_at: number
}

// In-memory double for the server-side UI-state plugin transport. Lets app
// persistence tests exercise server-first hydrate, last-write-wins, and migration
// without real HTTP or a running backend.
//
// Isolation: each instance owns its own record map. Create one per test.
// LWW: `put` only overwrites when the incoming `updated_at` is strictly newer than
// the stored record, so stale writes cannot clobber newer state.
export class MockServerState {
  private records = new Map<string, ServerRecord>()
  readonly calls = { get: 0, put: 0, list: 0, remove: 0 }
  // When set, every transport call rejects to simulate plugin/server unavailable.
  unavailable = false

  private guard() {
    if (this.unavailable) throw new Error("server state unavailable")
  }

  clear() {
    this.records.clear()
  }

  reset() {
    this.records.clear()
    this.calls.get = 0
    this.calls.put = 0
    this.calls.list = 0
    this.calls.remove = 0
    this.unavailable = false
  }

  // Seed a record directly without going through LWW (test setup helper).
  seed(name: string, record: ServerRecord) {
    this.records.set(name, record)
  }

  get(name: string): ServerRecord | undefined {
    this.calls.get += 1
    this.guard()
    const record = this.records.get(name)
    return record ? { ...record } : undefined
  }

  // Apply last-write-wins. Returns the record that is now authoritative.
  put(name: string, record: ServerRecord): ServerRecord {
    this.calls.put += 1
    this.guard()
    const existing = this.records.get(name)
    if (existing && existing.updated_at >= record.updated_at) return { ...existing }
    const next = { ...record }
    this.records.set(name, next)
    return { ...next }
  }

  list(): string[] {
    this.calls.list += 1
    this.guard()
    return Array.from(this.records.keys()).toSorted()
  }

  remove(name: string) {
    this.calls.remove += 1
    this.guard()
    this.records.delete(name)
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof init?.body === "string") return init.body
  if (input instanceof Request) return input.text()
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit) {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
}

function stateName(name: string, input: RequestInfo | URL, init?: RequestInit) {
  if (name !== "workspace:model-selection") return name
  const directory = requestHeaders(input, init).get("x-opencode-directory")
  if (!directory) return name
  return `${name}/${encodeURIComponent(directory || "/")}`
}

export function mockServerStateFetch(server: MockServerState): typeof fetch {
  const fetcher = (async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    const rawName = url.pathname.split("/state/")[1]
    if (!rawName) return json(404, { error: "not_found" })
    const name = stateName(rawName, input, init)

    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (method === "GET") return json(200, server.get(name) ?? { value: null, version: "v1", updated_at: 0 })
    if (method !== "PUT") return json(405, { error: "method_not_allowed" })

    const body = await requestBody(input, init)
    if (!body) return json(400, { error: "invalid_json" })

    const record = JSON.parse(body) as ServerRecord
    const current = server.get(name)
    const next = server.put(name, record)
    return json(200, { applied: !current || current.updated_at < record.updated_at, ...next })
  }) as typeof fetch
  fetcher.preconnect = globalThis.fetch.preconnect
  return fetcher
}
