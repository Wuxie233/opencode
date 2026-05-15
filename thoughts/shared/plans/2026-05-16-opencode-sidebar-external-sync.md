---
date: 2026-05-16
topic: "opencode-sidebar-external-sync"
issue: 1
scope: opencode-sidebar-sync
contract: thoughts/shared/plans/2026-05-16-opencode-sidebar-external-sync-contract.md
---

# OpenCode Sidebar External Sync Implementation Plan

**Goal:** Build a third-party sidebar sync layer plus browser extension/userscript and `/restart` download/pairing entry, without using OpenCode source patching as the main solution.

**Architecture:** Implement the sync service in the existing Cloudflare Worker/Durable Object boundary because this repo already has `packages/function/src/api.ts` and SST Worker infrastructure. Implement sync client artifacts under a new standalone `packages/sidebar-sync/` package so the browser extension/userscript can evolve independently from the OpenCode app and only interact with OpenCode via its existing persisted storage keys. Add the minimal `/restart` route in the existing app only as a safe discovery/fallback download page; deployment routing to `https://opencode.wuxie233.com/restart` remains an explicit boundary task because current infra targets `opencode.ai`, `app.opencode.ai`, and `api.opencode.ai`.

**Design:** `thoughts/shared/designs/2026-05-16-opencode-sidebar-external-sync-design.md` (validated in parent worktree; source copy was not present in `/root/CODE/issue-1-opencode` at planning time)

**Contract:** `thoughts/shared/plans/2026-05-16-opencode-sidebar-external-sync-contract.md`

**Context brief for executor/leaf agents:** Atlas status is `cannot-assess`: `atlas_lookup` returned “Atlas not initialized” for this worktree. Project Memory status is `read-only`: lookup for the sidebar external sync topic returned no matching entries. Mindmodel lookup returned stale workspace examples from another project, so follow the repo-local `AGENTS.md` instead: small TypeScript changes, no root tests, run package-local verification (`packages/function`, `packages/app`, `packages/sidebar-sync`), avoid `any`, avoid secret-bearing logs, and keep OpenCode source patching minimal.

**Planner decisions:** Design requires external sync. I am implementing it as a new package `packages/sidebar-sync` for extension/userscript artifacts, a Worker API extension in `packages/function/src/api.ts`, and a small app route for `/restart` because these are the smallest existing boundaries with deployable assets. Design requires `/restart` at `https://opencode.wuxie233.com/restart`; because this repo does not currently define that domain/route, Batch 1 includes deployment-boundary discovery and a minimal safe implementation path that does not restart OpenCode or mutate production DNS.

---

## Dependency Graph

```
Batch 1 (parallel): 1.1, 1.2, 1.3, 1.4, 1.5 [foundation and discovery - no deps]
Batch 2 (parallel): 2.1, 2.2, 2.3, 2.4, 2.5 [core implementation - depends on batch 1]
Batch 3 (parallel): 3.1, 3.2, 3.3, 3.4 [adapters and restart page - depends on batch 2]
Batch 4 (parallel): 4.1, 4.2, 4.3 [integration, security acceptance, packaging - depends on batch 3]
```

---

## Batch 1: Foundation and Discovery (parallel - 5 implementers)

All tasks in this batch have NO dependencies and run simultaneously.
Tasks: 1.1, 1.2, 1.3, 1.4, 1.5

### Task 1.1: Deployment Boundary Discovery
**File:** `thoughts/shared/plans/2026-05-16-opencode-sidebar-external-sync-deploy-boundary.md`
**Test:** none
**Depends:** none
**Domain:** general
**Atlas-impact:** none

Create a short discovery note that records the actual deployment boundary before implementation changes proceed. It must include:

- Evidence that `sst.config.ts` imports `infra/app.ts`, `infra/console.ts`, and `infra/enterprise.ts`.
- Evidence that `infra/app.ts` defines `api.${domain}`, `docs.${domain}`, and `app.${domain}` where `domain` currently comes from `infra/stage.ts` (`opencode.ai`, `dev.opencode.ai`, or stage subdomains).
- Evidence that no `/restart` route was found in `/root/CODE/issue-1-opencode` during planning.
- The selected minimal safe path: implement `/restart` as an app route plus static/artifact links, implement sync API under `/sidebar-sync/*`, and leave `opencode.wuxie233.com` DNS/proxy mapping as an ops follow-up unless the repo already has a stage-specific override.
- A hard constraint: do not restart OpenCode services and do not change production DNS in this implementation batch.

Use this exact starting content and add any additional evidence found:

```markdown
# OpenCode Sidebar Sync Deployment Boundary

## Finding

The current repo defines the deployable surfaces through SST:

- `sst.config.ts` imports `infra/app.ts`, `infra/console.ts`, and `infra/enterprise.ts`.
- `infra/app.ts` creates `api.${domain}` for `packages/function/src/api.ts`, `docs.${domain}` for `packages/web`, and `app.${domain}` for `packages/app`.
- `infra/stage.ts` maps production to `opencode.ai`, dev to `dev.opencode.ai`, and other stages to `${stage}.dev.opencode.ai`.
- No existing `/restart` route was found in this worktree before planning.

## Minimal safe implementation path

Implement the feature without patching OpenCode behavior as the primary solution:

1. Add `/sidebar-sync/*` endpoints to the existing Worker API.
2. Add standalone browser artifacts under `packages/sidebar-sync`.
3. Add a small `/restart` route in `packages/app` that explains install/pairing and links to artifacts.
4. Do not change production DNS or restart OpenCode in this task.

## Ops follow-up

The requested public URL is `https://opencode.wuxie233.com/restart`. If deployment ownership for that domain is outside this repo, route it to the built app/static page in ops after code lands.
```

**Verify:** `test -f thoughts/shared/plans/2026-05-16-opencode-sidebar-external-sync-deploy-boundary.md`
**Commit:** `docs(opencode-sidebar-sync): record restart deployment boundary`

### Task 1.2: Shared Sidebar Contract Types
**File:** `packages/sidebar-sync/src/contract.ts`
**Test:** `packages/sidebar-sync/src/contract.test.ts`
**Depends:** none
**Domain:** general
**Atlas-impact:** none

Create the new standalone package source file with strict shared types and whitelist validators used by both clients and service-oriented tests. This package is intentionally not an OpenCode app patch.

```typescript
export const SIDEBAR_SCHEMA_VERSION = 1
export const CURRENT_SERVER_STORAGE_KEY = "opencode.global.dat:server"
export const LEGACY_SERVER_STORAGE_KEY = "server.v3"

export type SidebarProjectState = {
  readonly worktree: string
  readonly expanded: boolean
}

export type SidebarStatePayload = {
  readonly schemaVersion: typeof SIDEBAR_SCHEMA_VERSION
  readonly projects: readonly SidebarProjectState[]
  readonly lastProject?: string
}

export type SidebarStateEnvelope = {
  readonly namespace: string
  readonly scope: string
  readonly version: number
  readonly updatedAt: string
  readonly updatedByDeviceId: string
  readonly payload: SidebarStatePayload
}

export type PairingCreatedResponse = {
  readonly code: string
  readonly expiresAt: string
}

export type DeviceTokenResponse = {
  readonly deviceId: string
  readonly token: string
  readonly expiresAt?: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly fields: Record<string, string> }

const forbiddenPattern = /(password|token|credential|secret|authorization|provider_auth|session|prompt|model|list)/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => forbiddenPattern.test(key) || containsForbiddenKey(child))
}

export function validateSidebarStatePayload(value: unknown): ValidationResult<SidebarStatePayload> {
  if (!isRecord(value)) return { ok: false, fields: { payload: "must be an object" } }
  if (containsForbiddenKey(value)) return { ok: false, fields: { payload: "contains forbidden sensitive fields" } }
  if (value.schemaVersion !== SIDEBAR_SCHEMA_VERSION) return { ok: false, fields: { schemaVersion: "must be 1" } }
  if (!Array.isArray(value.projects)) return { ok: false, fields: { projects: "must be an array" } }

  const projects = value.projects.flatMap((project, index) => {
    if (!isRecord(project)) return []
    if (typeof project.worktree !== "string" || project.worktree.trim() === "") return []
    if (typeof project.expanded !== "boolean") return []
    return [{ worktree: project.worktree, expanded: project.expanded }]
  })

  if (projects.length !== value.projects.length) return { ok: false, fields: { projects: "contains invalid project entries" } }
  if (value.lastProject !== undefined && typeof value.lastProject !== "string") {
    return { ok: false, fields: { lastProject: "must be a string when present" } }
  }

  return {
    ok: true,
    value: {
      schemaVersion: SIDEBAR_SCHEMA_VERSION,
      projects,
      ...(typeof value.lastProject === "string" ? { lastProject: value.lastProject } : {}),
    },
  }
}
```

Test requirements:

```typescript
import { describe, expect, test } from "bun:test"
import { containsForbiddenKey, validateSidebarStatePayload } from "./contract"

describe("sidebar sync contract", () => {
  test("accepts only sidebar project state", () => {
    const result = validateSidebarStatePayload({
      schemaVersion: 1,
      projects: [{ worktree: "/repo", expanded: true }],
      lastProject: "/repo",
    })

    expect(result.ok).toBeTrue()
    if (result.ok) expect(result.value.projects).toEqual([{ worktree: "/repo", expanded: true }])
  })

  test("rejects credential and unrelated server fields", () => {
    expect(containsForbiddenKey({ server: { list: [{ password: "pw" }] } })).toBeTrue()
    const result = validateSidebarStatePayload({
      schemaVersion: 1,
      projects: [{ worktree: "/repo", expanded: true, token: "secret" }],
    })

    expect(result.ok).toBeFalse()
  })
})
```

**Verify:** `cd packages/sidebar-sync && bun test src/contract.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add shared sidebar contract types`

### Task 1.3: Standalone Sidebar Sync Package Manifest
**File:** `packages/sidebar-sync/package.json`
**Test:** none
**Depends:** none
**Domain:** general
**Atlas-impact:** none

Create the new package manifest. Keep dependencies empty for the first pass; browser artifacts should use Web APIs and Bun build only.

```json
{
  "name": "@opencode-ai/sidebar-sync",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "bun run scripts/build.ts",
    "test": "bun test src",
    "typecheck": "tsgo -p tsconfig.json"
  },
  "devDependencies": {
    "@tsconfig/bun": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

**Verify:** `cd packages/sidebar-sync && bun pm pkg get name`
**Commit:** `chore(opencode-sidebar-sync): add sidebar sync package manifest`

### Task 1.4: Standalone Sidebar Sync TypeScript Config
**File:** `packages/sidebar-sync/tsconfig.json`
**Test:** none
**Depends:** none
**Domain:** general
**Atlas-impact:** none

Create a package-local TypeScript config for browser and Bun scripts.

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@tsconfig/bun/tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun-types"]
  },
  "include": ["src", "scripts"]
}
```

**Verify:** `cd packages/sidebar-sync && bun typecheck`
**Commit:** `chore(opencode-sidebar-sync): add sidebar sync tsconfig`

### Task 1.5: Extension Manifest Template
**File:** `packages/sidebar-sync/public/manifest.json`
**Test:** none
**Depends:** none
**Domain:** general
**Atlas-impact:** none

Create a Manifest V3 extension template that runs at `document_start` on the OpenCode domains. Keep permissions narrow and avoid host access outside the desired domains.

```json
{
  "manifest_version": 3,
  "name": "OpenCode Sidebar Sync",
  "version": "0.0.1",
  "description": "Synchronize only the OpenCode left sidebar project list state across paired personal browsers.",
  "permissions": ["storage"],
  "host_permissions": [
    "https://opencode.wuxie233.com/*",
    "https://app.opencode.ai/*",
    "https://*.dev.opencode.ai/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://opencode.wuxie233.com/*",
        "https://app.opencode.ai/*",
        "https://*.dev.opencode.ai/*"
      ],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_title": "OpenCode Sidebar Sync"
  }
}
```

**Verify:** `cd packages/sidebar-sync && bun -e 'JSON.parse(await Bun.file("public/manifest.json").text())'`
**Commit:** `feat(opencode-sidebar-sync): add extension manifest template`

---

## Batch 2: Core Implementation (parallel - 5 implementers)

All tasks in this batch depend on Batch 1 completing.
Tasks: 2.1, 2.2, 2.3, 2.4, 2.5

### Task 2.1: Persisted Store Extract and Merge Core
**File:** `packages/sidebar-sync/src/persisted-store.ts`
**Test:** `packages/sidebar-sync/src/persisted-store.test.ts`
**Depends:** 1.2
**Domain:** frontend-code
**Atlas-impact:** none

Implement pure parsing, extraction, and merge helpers for OpenCode persisted server storage. This is the critical security boundary: upload payloads must be whitelist-built from `projects[scope]` and `lastProject[scope]` only, while writes preserve unrelated local keys in the current persisted object.

Implementation requirements:

- Export `parsePersistedServer(raw: string | null): Record<string, unknown> | undefined`.
- Export `extractSidebarPayload(input: unknown, scope: string): SidebarStatePayload | undefined`.
- Export `mergeSidebarPayload(input: unknown, scope: string, payload: SidebarStatePayload): Record<string, unknown>`.
- Never return or upload `list`, `provider_auth`, `config`, `session`, `prompt`, `model`, `password`, `token`, or `credentials`.
- Preserve unrelated keys when merging into current storage so OpenCode continues to own its persisted schema.

```typescript
import { SIDEBAR_SCHEMA_VERSION, type SidebarProjectState, type SidebarStatePayload } from "./contract"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function parsePersistedServer(raw: string | null) {
  if (!raw) return
  try {
    const value = JSON.parse(raw) as unknown
    if (isRecord(value)) return value
  } catch {
    return
  }
}

function parseProject(value: unknown): SidebarProjectState | undefined {
  if (!isRecord(value)) return
  if (typeof value.worktree !== "string" || value.worktree.trim() === "") return
  if (typeof value.expanded !== "boolean") return
  return { worktree: value.worktree, expanded: value.expanded }
}

export function extractSidebarPayload(input: unknown, scope: string): SidebarStatePayload | undefined {
  if (!isRecord(input)) return
  const projectsByScope = isRecord(input.projects) ? input.projects : undefined
  const projects = Array.isArray(projectsByScope?.[scope])
    ? projectsByScope[scope].flatMap((value) => {
        const project = parseProject(value)
        return project ? [project] : []
      })
    : []
  const lastByScope = isRecord(input.lastProject) ? input.lastProject : undefined
  const lastProject = typeof lastByScope?.[scope] === "string" ? lastByScope[scope] : undefined

  if (projects.length === 0 && !lastProject) return
  return {
    schemaVersion: SIDEBAR_SCHEMA_VERSION,
    projects,
    ...(lastProject ? { lastProject } : {}),
  }
}

export function mergeSidebarPayload(input: unknown, scope: string, payload: SidebarStatePayload) {
  const current = isRecord(input) ? input : {}
  const projects = isRecord(current.projects) ? current.projects : {}
  const lastProject = isRecord(current.lastProject) ? current.lastProject : {}
  return {
    ...current,
    projects: {
      ...projects,
      [scope]: payload.projects.map((project) => ({ worktree: project.worktree, expanded: project.expanded })),
    },
    lastProject: {
      ...lastProject,
      ...(payload.lastProject ? { [scope]: payload.lastProject } : {}),
    },
  }
}
```

Test requirements:

```typescript
import { describe, expect, test } from "bun:test"
import { extractSidebarPayload, mergeSidebarPayload, parsePersistedServer } from "./persisted-store"

describe("OpenCode persisted server sidebar extraction", () => {
  test("extracts only projects and lastProject for one scope", () => {
    const payload = extractSidebarPayload(
      {
        list: [{ http: { password: "pw", url: "https://example" } }],
        projects: { local: [{ worktree: "/a", expanded: true }] },
        lastProject: { local: "/a" },
        provider_auth: { token: "secret" },
      },
      "local",
    )

    expect(payload).toEqual({ schemaVersion: 1, projects: [{ worktree: "/a", expanded: true }], lastProject: "/a" })
    expect(JSON.stringify(payload)).not.toContain("secret")
    expect(JSON.stringify(payload)).not.toContain("password")
  })

  test("merges sidebar payload while preserving unrelated current data", () => {
    const merged = mergeSidebarPayload(
      { list: ["http://localhost"], projects: { other: [{ worktree: "/b", expanded: false }] } },
      "local",
      { schemaVersion: 1, projects: [{ worktree: "/a", expanded: true }], lastProject: "/a" },
    )

    expect(merged.list).toEqual(["http://localhost"])
    expect(merged.projects).toEqual({ other: [{ worktree: "/b", expanded: false }], local: [{ worktree: "/a", expanded: true }] })
    expect(merged.lastProject).toEqual({ local: "/a" })
  })

  test("returns undefined for damaged JSON", () => {
    expect(parsePersistedServer("{")).toBeUndefined()
  })
})
```

**Verify:** `cd packages/sidebar-sync && bun test src/persisted-store.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add persisted sidebar extraction core`

### Task 2.2: Sidebar Sync API Client
**File:** `packages/sidebar-sync/src/api-client.ts`
**Test:** `packages/sidebar-sync/src/api-client.test.ts`
**Depends:** 1.2
**Domain:** frontend-code
**Atlas-impact:** none

Implement a small browser-safe API client for the frozen contract.

Implementation requirements:

- Export `createSidebarSyncClient(options)`.
- Use `fetch` injection for tests.
- Attach `Authorization: Bearer ${token}` only for state GET/PUT.
- Do not log token, payload body, or raw response body.
- Normalize base URL by trimming trailing slashes.
- Return `undefined` for GET 204.
- Throw descriptive errors containing method/path/status only.

```typescript
import type { DeviceTokenResponse, PairingCreatedResponse, SidebarStateEnvelope, SidebarStatePayload } from "./contract"

type FetchLike = typeof fetch

export type SidebarSyncClientOptions = {
  readonly baseUrl: string
  readonly token?: string
  readonly fetch?: FetchLike
}

const jsonHeaders = { "Content-Type": "application/json" }

async function readJson<T>(response: Response, method: string, path: string): Promise<T> {
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`)
  return (await response.json()) as T
}

export function createSidebarSyncClient(options: SidebarSyncClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const fetcher = options.fetch ?? fetch
  const request = (path: string, init?: RequestInit) => fetcher(`${baseUrl}${path}`, init)
  const authed = () => {
    if (!options.token) throw new Error("sidebar sync token is required")
    return { Authorization: `Bearer ${options.token}` }
  }

  return {
    async createPairing(label?: string) {
      return readJson<PairingCreatedResponse>(
        await request("/sidebar-sync/pairing", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ label }) }),
        "POST",
        "/sidebar-sync/pairing",
      )
    },
    async claimPairing(code: string, deviceName?: string) {
      const path = `/sidebar-sync/pairing/${encodeURIComponent(code)}/claim`
      return readJson<DeviceTokenResponse>(
        await request(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ deviceName }) }),
        "POST",
        path,
      )
    },
    async getState(namespace: string, scope: string) {
      const path = `/sidebar-sync/state/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`
      const response = await request(path, { method: "GET", headers: authed() })
      if (response.status === 204) return undefined
      return readJson<SidebarStateEnvelope>(response, "GET", path)
    },
    async putState(namespace: string, scope: string, baseVersion: number, payload: SidebarStatePayload) {
      const path = `/sidebar-sync/state/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`
      return readJson<SidebarStateEnvelope>(
        await request(path, {
          method: "PUT",
          headers: { ...jsonHeaders, ...authed() },
          body: JSON.stringify({ baseVersion, payload }),
        }),
        "PUT",
        path,
      )
    },
  }
}
```

**Verify:** `cd packages/sidebar-sync && bun test src/api-client.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add sync api client`

### Task 2.3: Client Sync Controller
**File:** `packages/sidebar-sync/src/sync-controller.ts`
**Test:** `packages/sidebar-sync/src/sync-controller.test.ts`
**Depends:** 2.1, 2.2
**Domain:** frontend-code
**Atlas-impact:** none

Implement the browser orchestration core shared by extension and userscript.

Implementation requirements:

- Export `restoreFromCache(storage, scope)` that synchronously writes cached payload to `opencode.global.dat:server` before OpenCode app initialization.
- Export `createSidebarSyncController(options)` with `start()` and `stop()`.
- Read current key first, legacy key second. Do not delete legacy data.
- Debounce uploads after storage changes.
- On remote fetch failure, keep local behavior and cached state.
- On 409 conflict, fetch latest and merge once before retrying upload.
- Use whitelist extraction from Task 2.1; never upload raw persisted storage.

Acceptance checks:

- A test proves cached write happens before any async remote fetch promise resolves.
- A test proves legacy key remains present after restore/upload.
- A test proves uploaded JSON does not include `list`, password, token, session, prompt, or model fields.

**Verify:** `cd packages/sidebar-sync && bun test src/sync-controller.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add sidebar sync controller`

### Task 2.4: Worker Sidebar Sync Service
**File:** `packages/function/src/api.ts`
**Test:** `packages/function/src/sidebar-sync.test.ts`
**Depends:** 1.2
**Domain:** backend
**Atlas-impact:** none

Extend the existing Hono Worker API with `/sidebar-sync/*` endpoints from the contract. Reuse the existing Durable Object binding style, but keep this state separate from session share keys.

Implementation requirements:

- Add pairing creation, pairing claim, state GET, and state PUT handlers.
- Store by `namespace/scope` and track `version`, `updatedAt`, and `updatedByDeviceId`.
- Generate random pairing codes and device tokens with `crypto.randomUUID()` or Web Crypto; never log token values.
- Validate payloads by whitelist, not by trusting the client.
- Reject any payload containing forbidden sensitive keys with 400.
- Return 409 with current state when `baseVersion` is stale.
- Preserve existing `/share_*`, `/feishu`, and GitHub endpoints unchanged.

Acceptance checks:

- Device can create/claim pairing and then GET/PUT state.
- Stale `baseVersion` returns `VersionConflict` and current state.
- Payload with `password`, `token`, `credentials`, `server.list`, `session`, `prompt`, or `model` anywhere is rejected and not logged.

**Verify:** `cd packages/function && bun test src/sidebar-sync.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add worker sidebar sync api`

### Task 2.5: Sidebar Sync Build Script
**File:** `packages/sidebar-sync/scripts/build.ts`
**Test:** none
**Depends:** 1.3, 1.5, 2.1, 2.2, 2.3
**Domain:** general
**Atlas-impact:** none

Create a Bun build script that outputs extension and userscript artifacts to `packages/sidebar-sync/dist/`.

Implementation requirements:

- Clean and recreate `dist/`.
- Bundle `src/extension-content.ts` to `dist/extension/content.js` when the file exists; before Task 3.1 lands, emit a warning and keep the build green.
- Copy `public/manifest.json` to `dist/extension/manifest.json`.
- Bundle `src/userscript.ts` to `dist/opencode-sidebar-sync.user.js` when the file exists; before Task 3.2 lands, emit a warning and keep the build green.
- Zip `dist/extension` to `dist/opencode-sidebar-sync-extension.zip` using Bun APIs or a simple no-dependency archive approach. If zip is too risky without dependency, emit `dist/extension/` and record zip as packaging follow-up in `dist/manifest.json`.
- Generate `dist/manifest.json` containing version, generatedAt, and SHA-256 hashes for produced artifacts.

**Verify:** `cd packages/sidebar-sync && bun run build`
**Commit:** `feat(opencode-sidebar-sync): add artifact build script`

---

## Batch 3: Adapters and Restart Page (parallel - 4 implementers)

All tasks in this batch depend on Batch 2 completing.
Tasks: 3.1, 3.2, 3.3, 3.4

### Task 3.1: Browser Extension Content Script
**File:** `packages/sidebar-sync/src/extension-content.ts`
**Test:** `packages/sidebar-sync/src/extension-content.test.ts`
**Depends:** 2.3
**Domain:** frontend-code
**Atlas-impact:** none

Implement the Manifest V3 content script adapter. This file should be thin: it wires extension storage and `window.localStorage` into the shared sync controller.

Implementation requirements:

- Run immediately at module evaluation so `document_start` restores cached payload before OpenCode initializes.
- Read pairing config from `chrome.storage.local` keys: `sidebarSyncBaseUrl`, `sidebarSyncNamespace`, `sidebarSyncToken`, and `sidebarSyncScope`.
- Default base URL to `https://api.opencode.wuxie233.com` only if no stored value exists; keep it configurable for staging.
- Use `localStorage` for OpenCode persisted key reads/writes.
- Listen for `storage` events and same-tab monkey-patch `Storage.prototype.setItem` only for `opencode.global.dat:server`; do not inspect or log other storage writes.
- Do not log token values or raw persisted contents.

Acceptance checks:

- Test with a fake `chrome.storage.local` and fake `localStorage` proves startup restore calls the controller synchronously.
- Test proves only `opencode.global.dat:server` changes are forwarded.

**Verify:** `cd packages/sidebar-sync && bun test src/extension-content.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add extension content adapter`

### Task 3.2: Userscript Fallback Adapter
**File:** `packages/sidebar-sync/src/userscript.ts`
**Test:** `packages/sidebar-sync/src/userscript.test.ts`
**Depends:** 2.3
**Domain:** frontend-code
**Atlas-impact:** none

Implement the userscript fallback adapter that reuses the shared controller.

Implementation requirements:

- Include a userscript metadata header for `https://opencode.wuxie233.com/*`, `https://app.opencode.ai/*`, and `https://*.dev.opencode.ai/*`.
- Use `GM_getValue` / `GM_setValue` / `GM_xmlhttpRequest` when available; fall back to `localStorage` and `fetch` with a clear diagnostic status.
- Provide a minimal `window.__OPENCODE_SIDEBAR_SYNC__` diagnostic object with safe fields only: `enabled`, `lastError`, `lastSyncAt`, `baseUrl`, `namespace`, `scope`, `version`.
- Do not expose token, pairing code, raw persisted JSON, or payload body on `window`.

Acceptance checks:

- Test proves diagnostic object omits token and raw payload.
- Test proves fallback adapter uses the same whitelist extraction path as extension.

**Verify:** `cd packages/sidebar-sync && bun test src/userscript.test.ts`
**Commit:** `feat(opencode-sidebar-sync): add userscript fallback adapter`

### Task 3.3: Restart Download and Pairing Page
**File:** `packages/app/src/pages/restart.tsx`
**Test:** `packages/app/src/pages/restart.test.tsx`
**Depends:** 2.2, 2.5
**Domain:** frontend-ui
**Atlas-impact:** none

Create the `/restart` page component. This is a download/pairing page, not a core OpenCode behavior patch.

Implementation requirements:

- Explain that sync scope is only opened sidebar projects, order, expanded flags, and lastProject.
- Explicitly state that `server.list`, passwords, tokens, credentials, model config, sessions, prompts, and historical `/project` full list are not synced.
- Show recommended install path by browser: Chrome/Edge extension, Firefox/userscript fallback for first release, mobile unsupported/read-only instructions.
- Call `POST /sidebar-sync/pairing` to display a pairing code and expiry.
- Link to `/restart/opencode-sidebar-sync.user.js`, `/restart/opencode-sidebar-sync-extension.zip`, and `/restart/manifest.json`.
- Display release version, generatedAt, and artifact hashes when manifest fetch succeeds.
- Provide safe failure state when API or manifest is unavailable.
- Do not ask user for credentials or tokens; pairing code is short-lived.

Acceptance checks:

- Render test confirms security scope text is visible.
- Render test confirms all artifact links exist.
- Render test confirms no password/token input exists.

**Verify:** `cd packages/app && bun test src/pages/restart.test.tsx`
**Commit:** `feat(opencode-sidebar-sync): add restart pairing page`

### Task 3.4: App Router Restart Route
**File:** `packages/app/src/app.tsx`
**Test:** none
**Depends:** 3.3
**Domain:** frontend-code
**Atlas-impact:** none

Register the new route with minimal OpenCode source change.

Implementation requirements:

- Add `const RestartRoute = lazy(() => import("@/pages/restart"))` near existing lazy routes.
- Add `<Route path="/restart" component={RestartRoute} />` before `/:dir` so the route is not interpreted as a project directory.
- Do not change `ServerProvider`, `GlobalSyncProvider`, or sidebar internals.
- Keep this as a routing shell only; the external sync behavior lives in `packages/sidebar-sync` and Worker API.

**Verify:** `cd packages/app && bun typecheck`
**Commit:** `feat(opencode-sidebar-sync): register restart route`

---

## Batch 4: Integration and Acceptance (parallel - 3 implementers)

All tasks in this batch depend on Batch 3 completing.
Tasks: 4.1, 4.2, 4.3

### Task 4.1: Restart Static Artifact Serving
**File:** `packages/app/vite.config.ts`
**Test:** none
**Depends:** 2.5, 3.3
**Domain:** general
**Atlas-impact:** none

Wire built sidebar-sync artifacts into the app build in the smallest safe way.

Implementation requirements:

- Inspect existing `packages/app/vite.config.ts` first.
- Add a Vite plugin or build step that copies from `packages/sidebar-sync/dist/` to app public output paths:
  - `/restart/manifest.json`
  - `/restart/opencode-sidebar-sync.user.js`
  - `/restart/opencode-sidebar-sync-extension.zip` when present, or a documented extension directory fallback when zip is not present.
- Do not modify OpenCode app runtime state or sidebar logic.
- Do not introduce a new root-level build command; use package-local scripts.

Acceptance checks:

- `packages/app/dist/restart/manifest.json` exists after build when sidebar-sync artifacts exist.
- Missing optional zip produces a clear build warning but does not break userscript availability.

**Verify:** `cd packages/sidebar-sync && bun run build && cd ../app && bun run build`
**Commit:** `feat(opencode-sidebar-sync): serve restart artifacts from app build`

### Task 4.2: End-to-End Sidebar Sync Acceptance Test
**File:** `packages/sidebar-sync/src/e2e-sidebar-sync.test.ts`
**Test:** `packages/sidebar-sync/src/e2e-sidebar-sync.test.ts`
**Depends:** 2.3, 2.4, 3.1, 3.2
**Domain:** frontend-code
**Atlas-impact:** none

Create a package-local integration-style test that simulates two browser devices with in-memory storage and a fake sync service.

Acceptance checks:

- Device A starts with a current `opencode.global.dat:server` value containing `projects.local` and `lastProject.local`.
- Device A uploads only `{ schemaVersion, projects, lastProject }`.
- Device B starts with empty current storage and a cached or remote state, then restores the same list order, expanded flags, and lastProject.
- Concurrent A/B edits use last-write-wins with version conflict handling and never clear the list to empty unless the user explicitly closed all projects.
- Legacy `server.v3` remains in storage after sync.
- Captured request bodies and logs do not contain `server.list`, `password`, `token`, `credentials`, `model`, `session`, or `prompt`.

**Verify:** `cd packages/sidebar-sync && bun test src/e2e-sidebar-sync.test.ts`
**Commit:** `test(opencode-sidebar-sync): add two-device sidebar sync acceptance`

### Task 4.3: Security Regression Test for Worker and Artifacts
**File:** `packages/function/src/sidebar-sync-security.test.ts`
**Test:** `packages/function/src/sidebar-sync-security.test.ts`
**Depends:** 2.4, 2.5
**Domain:** backend
**Atlas-impact:** none

Add backend-focused security regression coverage.

Acceptance checks:

- Worker rejects payloads containing any of these fields at any depth: `password`, `token`, `credentials`, `secret`, `authorization`, `provider_auth`, `session`, `prompt`, `model`, `list`.
- Rejected requests return field-level validation without echoing the payload.
- Console logging in sidebar-sync paths never receives token values or raw request payloads; monkey-patch `console.log/error` in the test to assert this.
- Artifact manifest hashes are safe metadata only and do not include secrets or raw local storage.
- Existing share endpoints still respond in their previous shape for a smoke request.

**Verify:** `cd packages/function && bun test src/sidebar-sync-security.test.ts`
**Commit:** `test(opencode-sidebar-sync): add worker security regression coverage`
