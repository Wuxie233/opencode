import type { Plugin, PluginInput, PluginStorage, PluginStorageRecord, PluginStorageScope } from "@opencode-ai/plugin"

// First-party, default-loaded opencode plugin that persists Web UI open-state and
// settings server-side. It is intentionally the ONLY place UI-state-specific
// behavior lives: core exposes a generic HTTP route seam (PluginRoute) and a
// generic plugin-scoped JSON/KV storage seam (PluginStorage); this plugin owns
// the v1 group set, the record shape, and the last-write-wins conflict policy.
//
// Endpoints are served under the reserved namespace `/api/plugin/opencode.web-state/*`
// via `input.experimental_route` and persisted via `input.experimental_storage`.
// Each group gets a versioned `GET`/`PUT` at `/state/<groupId>`.

// Stable plugin id. The HTTP namespace and storage namespace both derive from it.
export const ID = "opencode.web-state"

// Contract version every record is written under (mirrors
// packages/app/src/utils/ui-state-contract.ts UI_STATE_CONTRACT_VERSION). It is a
// string tag, NOT a numeric revision; `updated_at` is the sole LWW tiebreaker.
export const VERSION = "v1"

// State endpoints live under this path, relative to the plugin namespace, e.g.
// group "server" -> `/api/plugin/opencode.web-state/state/server`.
export const STATE_PREFIX = "/state/"

// Logical scope a group is reconciled under, mirroring the v1 contract's
// `UiStateScope`. "global" groups share one record across the whole app;
// "workspace" groups are keyed per worktree so two workspaces never collide.
type GroupScope = "global" | "workspace"

export type GroupDef = {
  id: string
  scope: GroupScope
}

// The set of group ids this plugin accepts GET/PUT for. It is a SUPERSET of the
// groups the app actually server-backs (see packages/app/src/utils/ui-state-contract.ts):
// the app and this server plugin cannot import each other, so the set is kept in
// sync by hand and guarded by tests on both sides. Extra ids are harmless (just
// unused routes); a missing id means that group cannot persist server-side.
export const GROUPS: readonly GroupDef[] = [
  { id: "server", scope: "global" },
  { id: "server.projects", scope: "global" },
  { id: "layout", scope: "global" },
  { id: "workspace:model-selection", scope: "workspace" },
  { id: "settings.v3", scope: "global" },
  { id: "command.catalog.v1", scope: "global" },
  { id: "model", scope: "global" },
  { id: "language", scope: "global" },
  { id: "permission", scope: "global" },
  { id: "notification", scope: "global" },
  { id: "tabs", scope: "global" },
]

// The wire/record shape for every group. `value` is the app-owned JSON payload;
// the plugin never interprets it. `version` + `updated_at` are the metadata the
// plugin uses to version records and resolve conflicts.
export type WebStateRecord = {
  value: unknown
  version: string
  updated_at: number
}

const writeQueues = new Map<string, Promise<void>>()

function writeQueueKey(scope: PluginStorageScope, key: string) {
  return `${scope}\u0000${key}`
}

async function serializeWrite<T>(key: string, run: () => Promise<T>) {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const result = previous.then(run, run)
  const cleanup = result
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (writeQueues.get(key) === cleanup) writeQueues.delete(key)
    })
  writeQueues.set(key, cleanup)
  return result
}

// The default empty record returned when no server record exists yet. `updated_at`
// is 0 so any real local value is strictly newer and wins on first sync, and the
// app deep-merges its own defaults over `value: null`.
function defaults(): WebStateRecord {
  return { value: null, version: VERSION, updated_at: 0 }
}

// Persisted records are stored as a PluginStorageRecord whose `metadata` carries
// version + updated_at, so the storage seam keeps them verbatim and the plugin
// owns interpretation. Rebuild a WebStateRecord from that on read.
function toRecord(stored: PluginStorageRecord): WebStateRecord {
  const metadata = stored.metadata ?? {}
  const version = typeof metadata.version === "string" ? metadata.version : VERSION
  const updated_at = typeof metadata.updated_at === "number" ? metadata.updated_at : 0
  return { value: stored.value, version, updated_at }
}

function parseRecord(body: unknown): WebStateRecord | undefined {
  if (!body || typeof body !== "object") return
  const record = body as Record<string, unknown>
  if (!("value" in record)) return
  if (typeof record.version !== "string" || record.version === "") return
  if (typeof record.updated_at !== "number" || !Number.isFinite(record.updated_at)) return
  if (record.updated_at < 0) return
  return { value: record.value, version: record.version, updated_at: record.updated_at }
}

// Storage key for a group. Global groups use the group id directly (one shared
// record). Workspace groups append the encoded worktree as a single key segment so
// each workspace gets its own record. encodeURIComponent never emits "/", and the
// "/" fallback keeps the segment non-empty (the storage seam rejects ""/"."/"..").
function storageKey(group: GroupDef, worktree: string): string {
  if (group.scope === "workspace") return `${group.id}/${encodeURIComponent(worktree || "/")}`
  return group.id
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function handleGet(storage: PluginStorage, scope: PluginStorageScope, key: string): Promise<Response> {
  const stored = await storage.get(scope, key)
  return json(200, stored ? toRecord(stored) : defaults())
}

async function handlePut(
  storage: PluginStorage,
  scope: PluginStorageScope,
  key: string,
  request: Request,
): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: "invalid_json" })
  }
  const incoming = parseRecord(raw)
  if (!incoming) return json(400, { error: "invalid_record" })

  // Last-write-wins by explicit `updated_at`: a write only persists when it is
  // strictly newer than the stored record. Stale or equal-timestamp writes leave
  // the existing record untouched and are reported back with `applied: false` plus
  // the authoritative record, so clients converge without an error path.
  return serializeWrite(writeQueueKey(scope, key), async () => {
    const stored = await storage.get(scope, key)
    const current = stored ? toRecord(stored) : undefined
    if (current && current.updated_at >= incoming.updated_at) {
      return json(200, { applied: false, ...current })
    }

    await storage.put(scope, key, {
      value: incoming.value,
      metadata: { version: incoming.version, updated_at: incoming.updated_at },
    })
    return json(200, { applied: true, ...incoming })
  })
}

// Only the seams the plugin actually needs. Tests provide these directly through
// the same public APIs production passes (the real PluginRoute registrar and a
// PluginStorage), so registration is exercised exactly as a real plugin would.
export type WebStateInput = Pick<PluginInput, "experimental_route" | "experimental_storage" | "worktree">

export function register(input: WebStateInput): void {
  for (const group of GROUPS) {
    const path = STATE_PREFIX + group.id
    const scope: PluginStorageScope = group.scope
    const key = storageKey(group, input.worktree)
    input.experimental_route.register("GET", path, () => handleGet(input.experimental_storage, scope, key))
    input.experimental_route.register("PUT", path, (request) => handlePut(input.experimental_storage, scope, key, request))
  }
}

export const plugin: Plugin = async (input) => {
  register(input)
  return {}
}

export * as WebState from "./web-state"
