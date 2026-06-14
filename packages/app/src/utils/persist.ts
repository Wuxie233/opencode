import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import { createSignal, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { pathKey } from "@/utils/path-key"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"
import { UI_STATE_CONTRACT_VERSION } from "@/utils/ui-state-contract"
import { resolveWebStateServer, webStateTransport } from "@/utils/web-state"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type MaybePromise<T> = T | Promise<T>

export type PersistServerRecord = {
  value: unknown
  version: string
  updated_at: number
}

type PersistServer = {
  group: string
  scope: ServerScopeValue
  directory?: string
}

type PersistTarget = {
  storage?: string
  scope?: "window"
  legacyStorageNames?: string[]
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
  server?: PersistServer
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "opencode.global.dat"
const WINDOW_STORAGE = "opencode.window"
const LOCAL_PREFIX = "opencode."
const SERVER_META_PREFIX = "__server:"
const SERVER_TIMEOUT_MS = 2_000
const fallback = new Map<string, boolean>()

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function fallbackDisabled(scope: string) {
  return fallback.get(scope) === true
}

function fallbackSet(scope: string) {
  fallback.set(scope, true)
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

function evict(storage: Storage, keep: string, value: string) {
  const total = storage.length
  const indexes = Array.from({ length: total }, (_, index) => index)
  const items: Evict[] = []

  for (const index of indexes) {
    const name = storage.key(index)
    if (!name) continue
    if (!name.startsWith(LOCAL_PREFIX)) continue
    if (name === keep) continue
    const stored = storage.getItem(name)
    items.push({ key: name, size: stored?.length ?? 0 })
  }

  items.sort((a, b) => b.size - a.size)

  for (const item of items) {
    storage.removeItem(item.key)
    cacheDelete(item.key)

    try {
      storage.setItem(keep, value)
      cacheSet(keep, value)
      return true
    } catch (error) {
      if (!quota(error)) throw error
    }
  }

  return false
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  try {
    storage.removeItem(key)
    cacheDelete(key)
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  const ok = evict(storage, key, value)
  return ok
}

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serverMetadataKey(key: string) {
  return `${SERVER_META_PREFIX}${key}`
}

function isServerRecord(value: unknown): value is PersistServerRecord {
  if (!isRecord(value)) return false
  if (!("value" in value)) return false
  if (value.version !== UI_STATE_CONTRACT_VERSION) return false
  if (typeof value.updated_at !== "number") return false
  if (!Number.isFinite(value.updated_at)) return false
  if (value.updated_at < 0) return false
  return true
}

function serverMetadata(value: string | null) {
  if (value === null) return 0
  const parsed = parse(value)
  if (!isServerRecord(parsed)) return 0
  return parsed.updated_at
}

async function serverCall<T>(input: { run: () => MaybePromise<T>; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? SERVER_TIMEOUT_MS
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(input.run()),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function serverAttempt(input: { run: () => MaybePromise<unknown>; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? SERVER_TIMEOUT_MS
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(input.run()).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function optionalStorage(input: () => MaybePromise<unknown>) {
  try {
    await input()
  } catch {
    return
  }
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown) {
  const parsed = parse(raw)
  if (parsed === undefined) return
  const migrated = migrate ? migrate(parsed) : parsed
  const merged = merge(defaults, migrated)
  return JSON.stringify(merged)
}

function readCurrent(input: {
  storage: SyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    input.storage.removeItem(input.key)
    return null
  }
  if (raw !== next) input.storage.setItem(input.key, next)
  return next
}

function migrateLegacy(input: {
  current: SyncStorage
  legacyStore?: SyncStorage
  stores: SyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      store.removeItem(input.key)
      continue
    }
    input.current.setItem(input.key, next)
    store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      input.legacyStore.removeItem(key)
      continue
    }
    input.current.setItem(input.key, next)
    input.legacyStore.removeItem(key)
    return next
  }

  return null
}

async function readCurrentAsync(input: {
  storage: AsyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = await input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    await input.storage.removeItem(input.key).catch(() => undefined)
    return null
  }
  if (raw !== next) await input.storage.setItem(input.key, next)
  return next
}

async function removeAsync(storage: AsyncStorage, key: string) {
  try {
    await storage.removeItem(key)
  } catch {}
}

async function migrateLegacyAsync(input: {
  current: AsyncStorage
  legacyStore?: AsyncStorage
  stores: AsyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = await store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(store, input.key)
      continue
    }
    await input.current.setItem(input.key, next)
    await store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = await input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(input.legacyStore, key)
      continue
    }
    await input.current.setItem(input.key, next)
    await input.legacyStore.removeItem(key)
    return next
  }

  return null
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `opencode.workspace.${head}.${sum}.dat`
}

function draftStorage(draftID: string) {
  const head = (draftID.slice(0, 12) || "draft").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(draftID) ?? "0"
  return `opencode.draft.${head}.${sum}.dat`
}

function windowStorage(windowID: string) {
  const safe = (windowID || "browser").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `${WINDOW_STORAGE}.${safe}.dat`
}

function legacyWorkspaceStorage(dir: string) {
  const storage = workspaceStorage(pathKey(dir))
  const result = new Set<string>()
  const raw = workspaceStorage(dir)
  if (raw !== storage) result.add(raw)

  const key = pathKey(dir)
  const drive = key.length >= 3 && key[1] === ":" && key[2] === "/"
  if (drive) {
    const backslash = workspaceStorage(key.replaceAll("/", "\\"))
    if (backslash !== storage) result.add(backslash)
  }

  if (result.size === 0) return
  return [...result]
}

function serverWorkspaceTarget(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
  if (scope !== ServerScope.local) {
    return {
      storage: workspaceStorage(ScopedKey.from(scope, pathKey(dir))),
      key,
      server: { group: key, scope, directory: dir },
    }
  }
  return {
    storage: workspaceStorage(pathKey(dir)),
    legacyStorageNames: legacyWorkspaceStorage(dir),
    key,
    legacy,
    server: { group: key, scope, directory: dir },
  }
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const scope = `prefix:${prefix}`
  const item = (key: string) => base + key
  return {
    getItem: (key) => {
      const name = item(key)
      const cached = cacheGet(name)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(name)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(name, stored)
      return stored
    },
    setItem: (key, value) => {
      const name = item(key)
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, name, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      const name = item(key)
      cacheDelete(name)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(name)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

function localStorageDirect(): SyncStorage {
  const scope = "direct"
  return {
    getItem: (key) => {
      const cached = cacheGet(key)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(key)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(key, stored)
      return stored
    },
    setItem: (key, value) => {
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, key, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      cacheDelete(key)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(key)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

function serverBackedStorage(input: {
  local: SyncStorage | AsyncStorage
  transport: { get: () => MaybePromise<unknown>; put: (record: PersistServerRecord) => MaybePromise<unknown> }
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}): AsyncStorage {
  const metaKey = serverMetadataKey(input.key)

  async function writeMarker(record: { version: string; updated_at: number }) {
    await optionalStorage(() =>
      input.local.setItem(
        metaKey,
        JSON.stringify({
          value: null,
          version: record.version,
          updated_at: record.updated_at,
        }),
      ),
    )
  }

  async function hydrateLocal(key: string, record: PersistServerRecord) {
    const next = normalize(input.defaults, JSON.stringify(record.value), input.migrate)
    if (next === undefined) return
    await optionalStorage(() => input.local.setItem(key, next))
    await writeMarker(record)
    return next
  }

  // Seed the server from local fallback once. Marker is written only after a
  // confirmed upload, so an unavailable server is retried on the next load.
  async function migrateUp(local: string, localUpdatedAt: number) {
    const parsed = parse(local)
    if (parsed === undefined) return
    const updatedAt = localUpdatedAt > 0 ? localUpdatedAt : Date.now()
    const record = { value: parsed, version: UI_STATE_CONTRACT_VERSION, updated_at: updatedAt }
    const uploaded = await serverAttempt({ run: () => input.transport.put(record) })
    if (uploaded) await writeMarker(record)
  }

  return {
    getItem: async (key) => {
      const local = await input.local.getItem(key)
      const localUpdatedAt = local === null ? 0 : serverMetadata(await input.local.getItem(metaKey))
      const remote = await serverCall({ run: () => input.transport.get() })

      if (isServerRecord(remote) && remote.value !== null && remote.updated_at > localUpdatedAt) {
        const next = await hydrateLocal(key, remote)
        if (next !== undefined) return next
        return local
      }

      if (isServerRecord(remote) && remote.value !== null && remote.updated_at >= localUpdatedAt) return local

      if (local !== null) await migrateUp(local, localUpdatedAt)
      return local
    },
    setItem: async (key, value) => {
      await input.local.setItem(key, value)
      const parsed = parse(value)
      if (parsed === undefined) return

      const record = { value: parsed, version: UI_STATE_CONTRACT_VERSION, updated_at: Date.now() }
      await writeMarker(record)
      const remote = await serverCall({ run: () => input.transport.put(record) })
      if (isServerRecord(remote) && remote.value !== null && remote.updated_at >= record.updated_at) {
        await hydrateLocal(key, remote)
      }
    },
    removeItem: async (key) => {
      await input.local.removeItem(key)
      await optionalStorage(() => input.local.removeItem(metaKey))
    },
  }
}

const DRAFT_PERSISTED_KEYS = ["prompt", "comments", "model-selection", "file-view", "layout"]

export function draftPersistedKeys() {
  return DRAFT_PERSISTED_KEYS
}

export const PersistTesting = {
  localStorageDirect,
  localStorageWithPrefix,
  migrateLegacy,
  normalize,
  resolveTarget,
  windowStorage,
  serverMetadataKey,
  workspaceStorage,
  resetCache() {
    cache.clear()
    cacheTotal.bytes = 0
    fallback.clear()
  },
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  window(key: string, legacy?: string[]): PersistTarget {
    return { scope: "window", key, legacy }
  },
  draft(draftID: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: draftStorage(draftID), key: `draft:${key}`, legacy }
  },
  serverGlobal(scope: ServerScopeValue, key: string, legacy?: string[]): PersistTarget {
    if (scope === ServerScope.local) return { storage: GLOBAL_STORAGE, key, legacy, server: { group: key, scope } }
    return { storage: GLOBAL_STORAGE, key: ScopedKey.from(scope, key), server: { group: key, scope } }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `workspace:${key}`, legacy)
  },
  serverWorkspace(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `workspace:${key}`, legacy)
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `session:${session}:${key}`, legacy)
  },
  serverSession(scope: ServerScopeValue, dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `session:${session}:${key}`, legacy)
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
  serverScoped(scope: ServerScopeValue, dir: string, session: string | undefined, key: string, legacy?: string[]) {
    if (session) return Persist.serverSession(scope, dir, session, key, legacy)
    return Persist.serverWorkspace(scope, dir, key, legacy)
  },
}

function resolveTarget(target: PersistTarget, platform: Platform): PersistTarget {
  if (target.scope !== "window") return target
  if (platform.platform === "desktop" && !platform.windowID) return { ...target, storage: GLOBAL_STORAGE }
  const windowID = platform.platform === "desktop" ? (platform.windowID ?? "browser") : "browser"
  return {
    ...target,
    storage: windowStorage(windowID),
  }
}

export function removePersisted(
  target: { storage?: string; legacyStorageNames?: string[]; key: string },
  platform?: Platform,
) {
  const isDesktop = platform?.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    void platform.storage?.(target.storage)?.removeItem(target.key)
    for (const storage of target.legacyStorageNames ?? []) {
      void platform.storage?.(storage)?.removeItem(target.key)
    }
    return
  }

  if (!target.storage) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
  for (const storage of target.legacyStorageNames ?? []) {
    localStorageWithPrefix(storage).removeItem(target.key)
  }
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const platform = usePlatform()
  const config = resolveTarget(typeof target === "string" ? { key: target } : target, platform)

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage

  const currentStorage = (() => {
    if (isDesktop) return platform.storage?.(config.storage)
    if (!config.storage) return localStorageDirect()
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!config.storage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const legacyStorageNames = config.legacyStorageNames ?? []

  const storage = (() => {
    if (!isDesktop) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage
      const legacyStores = legacyStorageNames.map(localStorageWithPrefix)

      const api: SyncStorage = {
        getItem: (key) => {
          const value = readCurrent({ storage: current, key, defaults, migrate: config.migrate })
          if (value !== undefined) return value
          return migrateLegacy({
            current,
            legacyStore,
            stores: legacyStores,
            keys: legacy,
            key,
            defaults,
            migrate: config.migrate,
          })
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined
    const legacyStores = legacyStorageNames
      .map((name) => platform.storage?.(name) as AsyncStorage | undefined)
      .filter((x) => !!x)

    const api: AsyncStorage = {
      getItem: async (key) => {
        const value = await readCurrentAsync({ storage: current, key, defaults, migrate: config.migrate })
        if (value !== undefined) return value
        return migrateLegacyAsync({
          current,
          legacyStore,
          stores: legacyStores,
          keys: legacy,
          key,
          defaults,
          migrate: config.migrate,
        })
      },
      setItem: async (key, value) => {
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const finalStorage = config.server && resolveWebStateServer(config.server.scope)
    ? serverBackedStorage({
        local: storage,
        transport: webStateTransport({ server: config.server }),
        key: config.key,
        defaults,
        migrate: config.migrate,
      })
    : storage

  const [state, setState, init] = makePersisted(store, { name: config.key, storage: finalStorage })

  const isAsync = init instanceof Promise
  const [ready, setReady] = createSignal(!isAsync)
  if (isAsync) void init.then(() => setReady(true))

  return [
    state,
    setState,
    init,
    Object.assign(() => ready(), {
      promise: init instanceof Promise ? init : undefined,
    }),
  ]
}
