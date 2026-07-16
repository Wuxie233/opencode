// v1 UI-state contract (app-side source of truth).
//
// This module is a pure declaration. It enumerates the browser-persisted UI-state
// groups that are synced to the server-side `opencode.web-state` plugin and pins
// the on-the-wire record shape. It deliberately contains NO runtime persistence
// wiring, no server I/O, and no migration behavior. The persistence adapter
// (persist.ts) and the transport helper (web-state.ts) both depend on this
// contract so the version string and record shape stay in one place.
//
// Conflict policy across clients is last-write-wins by the explicit `updated_at`
// timestamp, owned by the plugin (not core). `version` is a STRING contract
// version (e.g. "v1"), not a numeric monotonic revision.

export const UI_STATE_CONTRACT_VERSION = "v1" as const

// Where a group lives relative to a server. "global" groups are one record per
// server; "workspace"/"session" groups are sub-namespaced by the
// x-opencode-directory request header.
export type UiStateScope = "global" | "workspace" | "session"

// Metadata every server-side record MUST carry. Used to version records and to
// resolve conflicts via last-write-wins on `updated_at`.
export const UI_STATE_REQUIRED_METADATA = ["version", "updated_at"] as const
export type UiStateRequiredMetadata = (typeof UI_STATE_REQUIRED_METADATA)[number]

// On-the-wire record shape. `value` holds the serialized UI-state payload.
export type UiStateRecord = {
  value: unknown
  version: typeof UI_STATE_CONTRACT_VERSION
  updated_at: number
}

export type UiStateGroup = {
  // Stable server-side record group id (the `<group>` path segment the plugin
  // reads/writes under). Unique across the contract.
  id: string
  scope: UiStateScope
  // Logical browser-side persist key the group is written under.
  key: string
  // Whether the browser context attaches a `migrate` transform on read.
  hasMigrate: boolean
  // Source reference + default/merge behavior notes.
  notes: string
}

// Groups the app currently syncs server-side. Each maps a browser-persisted
// context to its server record group.
export const UI_STATE_GROUPS: readonly UiStateGroup[] = [
  {
    id: "server.projects",
    scope: "global",
    key: "server.projects",
    hasMigrate: false,
    notes: "context/server.tsx Persist.serverGlobal(scope(),'server.projects',['server.v3']); open projects + lastProject keyed by server scope; the server connection list itself stays local.",
  },
  {
    id: "settings.v3",
    scope: "global",
    key: "settings.v3",
    hasMigrate: false,
    notes: "context/settings.tsx Persist.serverGlobal(server.scope(),'settings.v3',['settings.v3']); defaultSettings deep-merged; legacy raw localStorage key migrated once.",
  },
  {
    id: "tabs",
    scope: "global",
    key: "tabs",
    hasMigrate: true,
    notes: "context/tabs.tsx Persist.serverGlobal(server.scope(),'tabs') with migrate; open session/draft tabs, defaults [].",
  },
  {
    id: "layout",
    scope: "global",
    key: "layout",
    hasMigrate: true,
    notes: "context/layout.tsx Persist.serverGlobal(scope,'layout',['layout.v6']); sidebar/file-tree/session tabs/view/scroll.",
  },
  {
    id: "layout.page",
    scope: "global",
    key: "layout.page",
    hasMigrate: false,
    notes: "pages/layout.tsx Persist.serverGlobal(scope,'layout.page',['layout.page.v1']); active project/workspace and sidebar ordering state.",
  },
  {
    id: "permission",
    scope: "global",
    key: "permission",
    hasMigrate: true,
    notes: "context/permission.tsx Persist.serverGlobal(scope,'permission',['permission.v3']); durable auto-accept rules.",
  },
  {
    id: "notification",
    scope: "global",
    key: "notification",
    hasMigrate: false,
    notes: "context/notification.tsx Persist.serverGlobal(scope,'notification',['notification.v1']); notification history.",
  },
  {
    id: "workspace:model-selection",
    scope: "workspace",
    key: "workspace:model-selection",
    hasMigrate: true,
    notes: "context/local.tsx Persist.serverWorkspace(scope,dir,'model-selection',['model-selection.v1']); per-worktree model/agent/variant via x-opencode-directory.",
  },
  {
    id: "workspace:vcs",
    scope: "workspace",
    key: "workspace:vcs",
    hasMigrate: false,
    notes: "context/global-sync/child-store.ts Persist.serverWorkspace(scope,dir,'vcs',['vcs.v1']); per-worktree git metadata cache.",
  },
  {
    id: "workspace:project",
    scope: "workspace",
    key: "workspace:project",
    hasMigrate: false,
    notes: "context/global-sync/child-store.ts Persist.serverWorkspace(scope,dir,'project',['project.v1']); per-worktree project metadata cache.",
  },
  {
    id: "workspace:icon",
    scope: "workspace",
    key: "workspace:icon",
    hasMigrate: false,
    notes: "context/global-sync/child-store.ts Persist.serverWorkspace(scope,dir,'icon',['icon.v1']); per-worktree icon override cache.",
  },
  {
    id: "workspace:terminal",
    scope: "workspace",
    key: "workspace:terminal",
    hasMigrate: true,
    notes: "context/terminal.tsx Persist.serverWorkspace(scope,dir,'terminal'); workspace terminal tab state.",
  },
  {
    id: "workspace:followup",
    scope: "workspace",
    key: "workspace:followup",
    hasMigrate: false,
    notes: "pages/session.tsx Persist.serverWorkspace(scope,dir,'followup',['followup.v1']); follow-up item state keyed by session.",
  },
]

// Exact set of group ids this contract covers.
export const UI_STATE_GROUP_IDS = [
  "server.projects",
  "settings.v3",
  "tabs",
  "layout",
  "layout.page",
  "permission",
  "notification",
  "workspace:model-selection",
  "workspace:vcs",
  "workspace:project",
  "workspace:icon",
  "workspace:terminal",
  "workspace:followup",
] as const
export type UiStateGroupId = (typeof UI_STATE_GROUP_IDS)[number]

export function isUiStateRecord(value: unknown): value is UiStateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!("value" in record)) return false
  if (record.version !== UI_STATE_CONTRACT_VERSION) return false
  if (typeof record.updated_at !== "number") return false
  if (!Number.isFinite(record.updated_at)) return false
  if (record.updated_at < 0) return false
  return true
}

export function uiStateGroup(id: string) {
  return UI_STATE_GROUPS.find((group) => group.id === id)
}

// The record GET returns when a group has never been written ("no remote").
export function defaultUiStateRecord(): UiStateRecord {
  return { value: null, version: UI_STATE_CONTRACT_VERSION, updated_at: 0 }
}
