export const SIDEBAR_SCHEMA_VERSION = 1
export const CURRENT_SERVER_STORAGE_KEY = "opencode.global.dat:server"
export const LEGACY_SERVER_STORAGE_KEY = "server.v3"

export interface SidebarProjectState {
  readonly worktree: string
  readonly expanded: boolean
}

export interface SidebarStatePayload {
  readonly schemaVersion: 1
  readonly projects: readonly SidebarProjectState[]
  readonly lastProject?: string
}

export interface SidebarStateEnvelope {
  readonly namespace: string
  readonly scope: string
  readonly version: number
  readonly updatedAt: string
  readonly updatedByDeviceId: string
  readonly payload: SidebarStatePayload
}

export interface PairingCreatedResponse {
  readonly code: string
  readonly expiresAt: string
}

export interface DeviceTokenResponse {
  readonly deviceId: string
  readonly token: string
  readonly expiresAt?: string
}

export interface CreatePairingRequest {
  readonly label?: string
}

export type CreatePairingResponse = PairingCreatedResponse

export interface ClaimPairingRequest {
  readonly deviceName?: string
}

export type ClaimPairingResponse = DeviceTokenResponse

export type GetSidebarStateResponse = SidebarStateEnvelope

export interface PutSidebarStateRequest {
  readonly baseVersion: number
  readonly payload: SidebarStatePayload
}

export type PutSidebarStateResponse = SidebarStateEnvelope

export interface SidebarConflictResponse {
  readonly error: "VersionConflict"
  readonly current: SidebarStateEnvelope
}

export type ValidationResult<T> =
  | {
      readonly ok: true
      readonly value: T
    }
  | {
      readonly ok: false
      readonly error: string
    }

const forbiddenKeys = new Set([
  "password",
  "token",
  "credential",
  "secret",
  "authorization",
  "provider_auth",
  "session",
  "prompt",
  "model",
  "list",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function findForbiddenKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) return value.map((entry, index) => findForbiddenKey(entry, `${path}.${index}`)).find(Boolean)
  if (!isRecord(value)) return undefined
  return Object.entries(value)
    .map(([key, entry]) => {
      if (forbiddenKeys.has(key.toLowerCase())) return path ? `${path}.${key}` : key
      return findForbiddenKey(entry, path ? `${path}.${key}` : key)
    })
    .find(Boolean)
}

export function containsForbiddenKey(value: unknown) {
  return findForbiddenKey(value) !== undefined
}

function validateProjectState(value: unknown, path: string): ValidationResult<SidebarProjectState> {
  if (!isRecord(value)) return { ok: false, error: `${path} must be an object` }

  const forbiddenKey = findForbiddenKey(value, path)
  if (forbiddenKey) return { ok: false, error: `Forbidden key: ${forbiddenKey}` }

  if (Object.keys(value).some((key) => key !== "worktree" && key !== "expanded")) {
    return { ok: false, error: `Unexpected key: ${path}.${Object.keys(value).find((key) => key !== "worktree" && key !== "expanded")}` }
  }

  if (typeof value.worktree !== "string") return { ok: false, error: `${path}.worktree must be a string` }
  if (typeof value.expanded !== "boolean") return { ok: false, error: `${path}.expanded must be a boolean` }

  return { ok: true, value: { worktree: value.worktree, expanded: value.expanded } }
}

export function validateSidebarStatePayload(value: unknown): ValidationResult<SidebarStatePayload> {
  if (!isRecord(value)) return { ok: false, error: "Payload must be an object" }

  const forbiddenKey = findForbiddenKey(value)
  if (forbiddenKey) return { ok: false, error: `Forbidden key: ${forbiddenKey}` }

  const unexpectedKey = Object.keys(value).find((key) => key !== "schemaVersion" && key !== "projects" && key !== "lastProject")
  if (unexpectedKey) return { ok: false, error: `Unexpected key: ${unexpectedKey}` }

  if (value.schemaVersion !== SIDEBAR_SCHEMA_VERSION) return { ok: false, error: "schemaVersion must be 1" }
  if (!Array.isArray(value.projects)) return { ok: false, error: "projects must be an array" }

  const projects = value.projects.map((project, index) => validateProjectState(project, `projects.${index}`))
  const projectError = projects.find((project) => !project.ok)
  if (projectError && !projectError.ok) return projectError

  if ("lastProject" in value && typeof value.lastProject !== "string") {
    return { ok: false, error: "lastProject must be a string" }
  }

  return {
    ok: true,
    value: {
      schemaVersion: SIDEBAR_SCHEMA_VERSION,
      projects: projects.map((project) => (project.ok ? project.value : undefined)).filter((project) => project !== undefined),
      ...(typeof value.lastProject === "string" ? { lastProject: value.lastProject } : {}),
    },
  }
}
