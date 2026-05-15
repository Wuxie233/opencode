import { describe, expect, test } from "bun:test"
import { createSidebarSyncClient } from "./api-client"
import {
  CURRENT_SERVER_STORAGE_KEY,
  LEGACY_SERVER_STORAGE_KEY,
  type PutSidebarStateRequest,
  type SidebarStateEnvelope,
  type SidebarStatePayload,
} from "./contract"
import { createSidebarSyncController } from "./sync-controller"

function createStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))

  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    snapshot() {
      return Object.fromEntries(values.entries())
    },
  }
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function parsePersisted(storage: ReturnType<typeof createStorage>) {
  return JSON.parse(storage.getItem(CURRENT_SERVER_STORAGE_KEY) ?? "{}")
}

function waitFor(predicate: () => boolean, message = "condition was not met") {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll)
      reject(new Error(message))
    }, 500)
    const poll = setInterval(() => {
      if (!predicate()) return
      clearTimeout(deadline)
      clearInterval(poll)
      resolve()
    }, 5)
  })
}

function createFakeSidebarSyncService() {
  let state: SidebarStateEnvelope | undefined
  const requestBodies: string[] = []
  const logs: string[] = []

  return {
    requestBodies,
    logs,
    current() {
      return state
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      logs.push(`${method} ${url.pathname}`)

      if (method === "GET") return state ? jsonResponse(state) : new Response(undefined, { status: 204 })

      const body = JSON.parse(String(init?.body)) as PutSidebarStateRequest
      requestBodies.push(String(init?.body))

      if (body.baseVersion !== (state?.version ?? 0) && state) {
        logs.push(`409 ${url.pathname} version=${state.version}`)
        return jsonResponse({ error: "VersionConflict", current: state }, { status: 409 })
      }

      state = {
        namespace: url.pathname.split("/").at(-2) ?? "personal",
        scope: url.pathname.split("/").at(-1) ?? "local",
        version: (state?.version ?? 0) + 1,
        updatedAt: "2026-05-16T00:00:00.000Z",
        updatedByDeviceId: method,
        payload: body.payload,
      }

      logs.push(`200 ${url.pathname} version=${state.version}`)
      return jsonResponse(state)
    },
  }
}

function noop() {}

function assertNoForbiddenLeak(values: readonly string[]) {
  const joined = values.join("\n")

  expect(joined).not.toContain("server.list")
  expect(joined).not.toContain("password")
  expect(joined).not.toContain("token")
  expect(joined).not.toContain("credentials")
  expect(joined).not.toContain("model")
  expect(joined).not.toContain("session")
  expect(joined).not.toContain("prompt")
}

describe("end-to-end sidebar sync", () => {
  test("syncs sanitized sidebar state across devices and resolves version conflicts", async () => {
    const service = createFakeSidebarSyncService()
    const deviceA = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: {
          local: [
            { worktree: "/repo/alpha", expanded: true, token: "project-token" },
            { worktree: "/repo/beta", expanded: false, credentials: "project-credentials" },
          ],
        },
        lastProject: { local: "/repo/beta" },
        "server.list": ["http://localhost:4096"],
        password: "persisted-password",
        token: "persisted-token",
        credentials: "persisted-credentials",
        model: "persisted-model",
        session: "persisted-session",
        prompt: "persisted-prompt",
      }),
      [LEGACY_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/legacy-a", expanded: true }] },
        lastProject: { local: "/repo/legacy-a" },
      }),
    })
    const deviceB = createStorage({
      [LEGACY_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/legacy-b", expanded: false }] },
        lastProject: { local: "/repo/legacy-b" },
      }),
    })
    let notifyA = noop
    let notifyB = noop
    const clientA = createSidebarSyncClient({ baseUrl: "https://sync.example.test", token: "device-a-token", fetch: service.fetch })
    const clientB = createSidebarSyncClient({ baseUrl: "https://sync.example.test", token: "device-b-token", fetch: service.fetch })
    const controllerA = createSidebarSyncController({
      storage: deviceA,
      scope: "local",
      debounceMs: 1,
      subscribe(listener) {
        notifyA = listener
        return () => {
          notifyA = noop
        }
      },
      apiClient: {
        fetchState(scope) {
          return clientA.getState("personal", scope)
        },
        uploadState(scope, baseVersion, payload) {
          return clientA.putState("personal", scope, { baseVersion, payload })
        },
      },
    })

    controllerA.start()
    await Promise.resolve()
    notifyA()
    await waitFor(() => service.requestBodies.length === 1, `first upload was not observed: ${JSON.stringify(service.logs)}`)

    expect(JSON.parse(service.requestBodies[0] ?? "{}")).toEqual({
      baseVersion: 0,
      payload: {
        schemaVersion: 1,
        projects: [
          { worktree: "/repo/alpha", expanded: true },
          { worktree: "/repo/beta", expanded: false },
        ],
        lastProject: "/repo/beta",
      } satisfies SidebarStatePayload,
    })
    expect(Object.keys(JSON.parse(service.requestBodies[0] ?? "{}").payload).sort()).toEqual(["lastProject", "projects", "schemaVersion"])

    const controllerB = createSidebarSyncController({
      storage: deviceB,
      scope: "local",
      debounceMs: 1,
      subscribe(listener) {
        notifyB = listener
        return () => {
          notifyB = noop
        }
      },
      apiClient: {
        fetchState(scope) {
          return clientB.getState("personal", scope)
        },
        uploadState(scope, baseVersion, payload) {
          return clientB.putState("personal", scope, { baseVersion, payload })
        },
      },
    })

    controllerB.start()
    await waitFor(() => parsePersisted(deviceB).lastProject?.local === "/repo/beta", `device B did not restore: ${JSON.stringify(deviceB.snapshot())}`)

    expect(parsePersisted(deviceB).projects.local).toEqual([
      { worktree: "/repo/alpha", expanded: true },
      { worktree: "/repo/beta", expanded: false },
    ])
    expect(deviceA.getItem(LEGACY_SERVER_STORAGE_KEY)).toContain("/repo/legacy-a")
    expect(deviceB.getItem(LEGACY_SERVER_STORAGE_KEY)).toContain("/repo/legacy-b")

    deviceA.setItem(
      CURRENT_SERVER_STORAGE_KEY,
      JSON.stringify({ projects: { local: [{ worktree: "/repo/alpha-a", expanded: false }] }, lastProject: { local: "/repo/alpha-a" } }),
    )
    notifyA()
    await waitFor(() => service.current()?.version === 2, `device A edit did not upload: ${JSON.stringify({ logs: service.logs, requestBodies: service.requestBodies, deviceA: deviceA.snapshot() })}`)

    deviceB.setItem(
      CURRENT_SERVER_STORAGE_KEY,
      JSON.stringify({ projects: { local: [{ worktree: "/repo/beta-b", expanded: true }] }, lastProject: { local: "/repo/beta-b" } }),
    )
    notifyB()
    await waitFor(() => service.current()?.version === 3, `device B edit did not upload: ${JSON.stringify({ logs: service.logs, requestBodies: service.requestBodies, deviceB: deviceB.snapshot() })}`)

    expect(service.current()?.payload).toEqual({
      schemaVersion: 1,
      projects: [{ worktree: "/repo/beta-b", expanded: true }],
      lastProject: "/repo/beta-b",
    })
    expect(JSON.parse(service.requestBodies.at(-1) ?? "{}").baseVersion).toBe(2)
    expect(service.current()?.payload.projects).not.toEqual([])

    assertNoForbiddenLeak(service.requestBodies)
    assertNoForbiddenLeak(service.logs)
    expect(deviceA.getItem(LEGACY_SERVER_STORAGE_KEY)).toContain("/repo/legacy-a")
    expect(deviceB.getItem(LEGACY_SERVER_STORAGE_KEY)).toContain("/repo/legacy-b")

    controllerA.stop()
    controllerB.stop()
  })
})
