import type { ServerScope } from "@/utils/server-scope"
import type { PersistServerRecord } from "@/utils/persist"

// Single transport seam for the server-side `opencode.web-state` plugin.
//
// Option B: persistence is driven entirely by PersistTarget.server metadata
// ({ group, scope, directory }). This helper resolves the active server URL from
// the app-side server registry, binds fetch, and issues GET/PUT against
// /api/plugin/opencode.web-state/state/<group>. Workspace/session groups carry
// the workspace path in the x-opencode-directory header so the plugin can
// sub-namespace records per directory.

const PLUGIN_ID = "opencode.web-state"

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type WebStateServerConnection = {
  url: string
  fetch: typeof fetch
  headers?: Record<string, string>
}

type WebStateServerResolver = (scope: ServerScope) => WebStateServerConnection | undefined

const resolvers = new Set<WebStateServerResolver>()

export type WebStateTarget = {
  group: string
  scope: ServerScope
  directory?: string
}

export type WebStateTransport = {
  get: () => Promise<unknown>
  put: (record: PersistServerRecord) => Promise<unknown>
}

export function registerWebStateServerResolver(resolver: WebStateServerResolver) {
  resolvers.add(resolver)
  return () => resolvers.delete(resolver)
}

export function resolveWebStateServer(scope: ServerScope) {
  // Most-recently registered resolver wins, so a fresh ServerProvider
  // registration supersedes any stale one without relying on cleanup order.
  for (const resolver of [...resolvers].reverse()) {
    const connection = resolver(scope)
    if (connection) return connection
  }
}

// Test-only: clear all registered resolvers. Real code never calls this; it
// exists so persistence tests stay isolated from each other's resolver
// registrations (the resolver registry is module-level/global).
export function resetWebStateServerResolvers() {
  resolvers.clear()
}

// Always invoke fetch with globalThis as the receiver. A platform-provided fetch
// (or globalThis.fetch) throws "Illegal invocation" when called as a detached
// reference, so rebind it here.
function boundFetch(input: typeof fetch): Fetcher {
  return (resource, init) => input.call(globalThis, resource, init)
}

export function webStateTransport(input: {
  server: WebStateTarget
}): WebStateTransport {
  async function request(method: "GET" | "PUT", record?: PersistServerRecord) {
    const connection = resolveWebStateServer(input.server.scope)
    if (!connection) throw new Error("web state server unavailable")
    const target = new URL(connection.url)
    const endpoint = new URL(`/api/plugin/${PLUGIN_ID}/state/${input.server.group}`, target)

    const headers = new Headers({ accept: "application/json", ...connection.headers })
    if (input.server.directory) headers.set("x-opencode-directory", input.server.directory)
    if (record) headers.set("content-type", "application/json")

    const response = await boundFetch(connection.fetch)(endpoint, {
      method,
      headers,
      body: record ? JSON.stringify(record) : undefined,
    })
    if (!response.ok) throw new Error(`web state ${response.status}`)
    return response.json() as Promise<unknown>
  }

  return {
    get: () => request("GET"),
    put: (record) => request("PUT", record),
  }
}
