// v1 UI-state contract.
//
// This module is a pure declaration: it maps each browser-persisted UI-state
// group (see packages/app/src/context/*) to the server-side record group that a
// future UI-state plugin will sync against. It deliberately contains NO runtime
// persistence wiring, no server I/O, and no migration behavior. It exists so the
// plugin endpoints, persistence adapter, and migration tasks can share one
// authoritative mapping.
//
// Conflict policy across clients is last-write-wins by the explicit `updated_at`
// timestamp, owned by the plugin (not core).

export const UI_STATE_CONTRACT_VERSION = "v1" as const

export type UiStateScope = "global" | "workspace"

// How a stored value is reconciled against its defaults when read back.
// "deep-merge" mirrors persist.ts `merge()` (defaults deep-merged with stored).
// "replace" means the stored value wholly replaces defaults.
export type UiStateMergeStrategy = "deep-merge" | "replace"

// Where the current browser implementation physically stores the group.
// "global-dat"    -> Persist.global(...)    -> opencode.global.dat
// "workspace-dat" -> Persist.workspace(...) -> opencode.workspace.<head>.<sum>.dat
// "direct-local"  -> persisted("<key>", ...) -> raw localStorage, no .dat prefix
export type UiStateStorageTarget = "global-dat" | "workspace-dat" | "direct-local"

// Metadata every server-side record group MUST carry. Used by the plugin to
// version records and to resolve conflicts via last-write-wins on `updated_at`.
export const UI_STATE_REQUIRED_METADATA = ["version", "updated_at"] as const
export type UiStateRequiredMetadata = (typeof UI_STATE_REQUIRED_METADATA)[number]

export type UiStateMetadataRequirement = {
  version: {
    field: "version"
    required: true
    // `version` is a STRING contract version (e.g. "v1"), NOT a numeric
    // monotonic revision. It pins the shape a record was written under so the
    // plugin can refuse/upgrade records from an unknown contract.
    type: "string"
    value: typeof UI_STATE_CONTRACT_VERSION
    description: string
  }
  updatedAt: {
    field: "updated_at"
    required: true
    type: "number"
    description: string
  }
}

export type UiStateRecord = {
  // Stable group id. Matches the persist key (or workspace-prefixed key) used by
  // the current browser implementation. Must be unique across the contract.
  id: string
  // Server-side record group name the plugin reads/writes under this scope.
  record: string
  scope: UiStateScope
  // Current browser-side storage key passed to persisted()/Persist.*.
  key: string
  storageTarget: UiStateStorageTarget
  // Older localStorage keys still migrated from, in order, by persist.ts.
  legacyKeys: readonly string[]
  // Whether the current context attaches a `migrate` transform on read.
  hasMigrate: boolean
  merge: UiStateMergeStrategy
  // Metadata fields the server record must carry (version + updated_at).
  requiresMetadata: readonly UiStateRequiredMetadata[]
  // Source reference + default/merge behavior notes.
  notes: string
}

export type UiStateContract = {
  version: typeof UI_STATE_CONTRACT_VERSION
  metadata: UiStateMetadataRequirement
  records: readonly UiStateRecord[]
}

const METADATA: UiStateMetadataRequirement = {
  version: {
    field: "version",
    required: true,
    type: "string",
    value: UI_STATE_CONTRACT_VERSION,
    description: "String contract version this record was written under (e.g. 'v1'); not a numeric revision.",
  },
  updatedAt: {
    field: "updated_at",
    required: true,
    type: "number",
    description: "Epoch millis of the last write; sole tiebreaker for last-write-wins.",
  },
}

const RECORDS: readonly UiStateRecord[] = [
  {
    id: "server",
    record: "server",
    scope: "global",
    key: "server",
    storageTarget: "global-dat",
    legacyKeys: ["server.v3"],
    hasMigrate: false,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/server.tsx:104 Persist.global('server',['server.v3']); defaults {list,projects,lastProject}.",
  },
  {
    id: "layout",
    record: "layout",
    scope: "global",
    key: "layout",
    storageTarget: "global-dat",
    legacyKeys: ["layout.v6"],
    hasMigrate: true,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/layout.tsx:229 Persist.global('layout',['layout.v6']) with migrate; sidebar/terminal/sessionTabs open-state.",
  },
  {
    id: "workspace:model-selection",
    record: "model-selection",
    scope: "workspace",
    key: "workspace:model-selection",
    storageTarget: "workspace-dat",
    legacyKeys: ["model-selection.v1"],
    hasMigrate: true,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/local.tsx:69 Persist.workspace(dir,'model-selection',['model-selection.v1']) with migrate; per-workspace session model state.",
  },
  {
    id: "settings.v3",
    record: "settings",
    scope: "global",
    key: "settings.v3",
    storageTarget: "direct-local",
    legacyKeys: [],
    hasMigrate: false,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/settings.tsx:156 persisted('settings.v3',...); raw localStorage key, no .dat prefix, defaultSettings deep-merged.",
  },
  {
    id: "command.catalog.v1",
    record: "command-catalog",
    scope: "global",
    key: "command.catalog.v1",
    storageTarget: "global-dat",
    legacyKeys: [],
    hasMigrate: false,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/command.tsx:244 Persist.global('command.catalog.v1'); keybind catalog record map, no legacy key.",
  },
  {
    id: "model",
    record: "model",
    scope: "global",
    key: "model",
    storageTarget: "global-dat",
    legacyKeys: ["model.v1"],
    hasMigrate: false,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/models.tsx:30 Persist.global('model',['model.v1']); defaults {user,recent,variant}.",
  },
  {
    id: "language",
    record: "language",
    scope: "global",
    key: "language",
    storageTarget: "global-dat",
    legacyKeys: ["language.v1"],
    hasMigrate: false,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/language.tsx:197 Persist.global('language',['language.v1']); defaults {locale}.",
  },
  {
    id: "permission",
    record: "permission",
    scope: "global",
    key: "permission",
    storageTarget: "global-dat",
    legacyKeys: ["permission.v3"],
    hasMigrate: true,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/permission.tsx:61 Persist.global('permission',['permission.v3']) with migrate; autoAccept reshaping on read.",
  },
  {
    id: "notification",
    record: "notification",
    scope: "global",
    key: "notification",
    storageTarget: "global-dat",
    legacyKeys: ["notification.v1"],
    hasMigrate: false,
    merge: "deep-merge",
    requiresMetadata: UI_STATE_REQUIRED_METADATA,
    notes: "context/notification.tsx:126 Persist.global('notification',['notification.v1']); defaults {list}.",
  },
]

export const UI_STATE_CONTRACT: UiStateContract = {
  version: UI_STATE_CONTRACT_VERSION,
  metadata: METADATA,
  records: RECORDS,
}

// Exact set of v1 group ids this contract is required to cover.
export const UI_STATE_GROUP_IDS = [
  "server",
  "layout",
  "workspace:model-selection",
  "settings.v3",
  "command.catalog.v1",
  "model",
  "language",
  "permission",
  "notification",
] as const
export type UiStateGroupId = (typeof UI_STATE_GROUP_IDS)[number]

export function uiStateRecord(id: string): UiStateRecord | undefined {
  return UI_STATE_CONTRACT.records.find((record) => record.id === id)
}
