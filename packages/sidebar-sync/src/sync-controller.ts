import {
  CURRENT_SERVER_STORAGE_KEY,
  LEGACY_SERVER_STORAGE_KEY,
  SIDEBAR_SCHEMA_VERSION,
  type SidebarProjectState,
  type SidebarStateEnvelope,
  type SidebarStatePayload,
} from "./contract"

export interface SidebarSyncStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SidebarSyncApiClient {
  fetchState(scope: string): Promise<SidebarStateEnvelope | undefined>
  uploadState(scope: string, baseVersion: number, payload: SidebarStatePayload): Promise<SidebarStateEnvelope>
}

export interface SidebarSyncControllerOptions {
  readonly storage: SidebarSyncStorage
  readonly scope: string
  readonly apiClient: SidebarSyncApiClient
  readonly debounceMs?: number
  readonly subscribe?: (listener: () => void) => () => void
}

export interface SidebarSyncController {
  start(): void
  stop(): void
}

function parsePersistedServer(value: string | null) {
  if (!value) return undefined

  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPersistedServer(storage: SidebarSyncStorage) {
  return parsePersistedServer(storage.getItem(CURRENT_SERVER_STORAGE_KEY)) ?? parsePersistedServer(storage.getItem(LEGACY_SERVER_STORAGE_KEY))
}

function isSidebarProjectState(value: unknown): value is SidebarProjectState {
  return isRecord(value) && typeof value.worktree === "string" && typeof value.expanded === "boolean"
}

function extractScopedPayload(persisted: Record<string, unknown> | undefined, scope: string): SidebarStatePayload | undefined {
  const projects = isRecord(persisted?.projects) ? persisted.projects : undefined
  const scopedProjects = projects && scope in projects && Array.isArray(projects[scope]) ? projects[scope].filter(isSidebarProjectState) : undefined

  if (!scopedProjects) return undefined

  const lastProject =
    isRecord(persisted?.lastProject) &&
    typeof persisted.lastProject[scope] === "string"
      ? persisted.lastProject[scope]
      : undefined

  return {
    schemaVersion: SIDEBAR_SCHEMA_VERSION,
    projects: scopedProjects.map((project) => ({ worktree: project.worktree, expanded: project.expanded })),
    ...(lastProject ? { lastProject } : {}),
  }
}

function writeScopedPayload(storage: SidebarSyncStorage, scope: string, payload: SidebarStatePayload) {
  const persisted = parsePersistedServer(storage.getItem(CURRENT_SERVER_STORAGE_KEY)) ?? readPersistedServer(storage) ?? {}
  const projects = isRecord(persisted.projects) ? persisted.projects : {}
  const lastProject = isRecord(persisted.lastProject) ? persisted.lastProject : {}

  storage.setItem(
    CURRENT_SERVER_STORAGE_KEY,
    JSON.stringify({
      ...persisted,
      projects: { ...projects, [scope]: payload.projects },
      lastProject: payload.lastProject ? { ...lastProject, [scope]: payload.lastProject } : lastProject,
    }),
  )
}

function mergePayload(local: SidebarStatePayload | undefined, remote: SidebarStatePayload): SidebarStatePayload {
  if (!local) return remote

  return {
    schemaVersion: SIDEBAR_SCHEMA_VERSION,
    projects: local.projects,
    ...(local.lastProject ? { lastProject: local.lastProject } : remote.lastProject ? { lastProject: remote.lastProject } : {}),
  }
}

export function restoreFromCache(storage: SidebarSyncStorage, scope: string) {
  const payload = extractScopedPayload(readPersistedServer(storage), scope)
  if (payload) writeScopedPayload(storage, scope, payload)
}

export function createSidebarSyncController(options: SidebarSyncControllerOptions): SidebarSyncController {
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  let baseVersion = 0

  const upload = async (retryConflict = true): Promise<void> => {
    const payload = extractScopedPayload(readPersistedServer(options.storage), options.scope)
    if (!payload) return

    try {
      const envelope = await options.apiClient.uploadState(options.scope, baseVersion, payload)
      baseVersion = envelope.version
    } catch (error) {
      if (!retryConflict || typeof error !== "object" || error === null || !("current" in error)) return

      const current = (error as { readonly current?: SidebarStateEnvelope }).current
      if (!current) return

      baseVersion = current.version
      const merged = mergePayload(extractScopedPayload(readPersistedServer(options.storage), options.scope), current.payload)
      writeScopedPayload(options.storage, options.scope, merged)
      await upload(false)
    }
  }

  const scheduleUpload = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void upload()
    }, options.debounceMs ?? 500)
  }

  return {
    start() {
      if (!stopped) return

      stopped = false
      restoreFromCache(options.storage, options.scope)
      unsubscribe = options.subscribe?.(scheduleUpload)

      void options.apiClient.fetchState(options.scope).then((envelope) => {
        if (!envelope || stopped) return
        baseVersion = envelope.version
        writeScopedPayload(options.storage, options.scope, envelope.payload)
      }).catch(() => undefined)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
