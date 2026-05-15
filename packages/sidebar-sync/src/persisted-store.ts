import { SIDEBAR_SCHEMA_VERSION, type SidebarProjectState, type SidebarStatePayload } from "./contract"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractProjectState(value: unknown): SidebarProjectState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.worktree !== "string") return undefined
  if (typeof value.expanded !== "boolean") return undefined
  return { worktree: value.worktree, expanded: value.expanded }
}

export function parsePersistedServer(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null) return undefined

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function extractSidebarPayload(input: unknown, scope: string): SidebarStatePayload | undefined {
  if (!isRecord(input)) return undefined
  if (!isRecord(input.projects)) return undefined

  const projects = input.projects[scope]
  if (!Array.isArray(projects)) return undefined

  return {
    schemaVersion: SIDEBAR_SCHEMA_VERSION,
    projects: projects.map(extractProjectState).filter((project) => project !== undefined),
    ...(isRecord(input.lastProject) && typeof input.lastProject[scope] === "string" ? { lastProject: input.lastProject[scope] } : {}),
  }
}

export function mergeSidebarPayload(input: unknown, scope: string, payload: SidebarStatePayload): Record<string, unknown> {
  const current = isRecord(input) ? input : {}
  const projects = isRecord(current.projects) ? current.projects : {}
  const lastProject = isRecord(current.lastProject) ? current.lastProject : {}

  return {
    ...current,
    projects: {
      ...projects,
      [scope]: payload.projects,
    },
    lastProject:
      payload.lastProject === undefined
        ? Object.fromEntries(Object.entries(lastProject).filter(([key]) => key !== scope))
        : {
            ...lastProject,
            [scope]: payload.lastProject,
          },
  }
}
