import { describe, expect, test } from "bun:test"
import { CURRENT_SERVER_STORAGE_KEY, LEGACY_SERVER_STORAGE_KEY, type SidebarStateEnvelope } from "./contract"
import { createSidebarSyncController, restoreFromCache } from "./sync-controller"

function createStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))

  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
    snapshot() {
      return Object.fromEntries(values.entries())
    },
  }
}

const localEnvelope: SidebarStateEnvelope = {
  namespace: "personal",
  scope: "local",
  version: 1,
  updatedAt: "2026-05-16T00:00:00.000Z",
  updatedByDeviceId: "device-1",
  payload: { schemaVersion: 1, projects: [{ worktree: "/repo/remote", expanded: true }], lastProject: "/repo/remote" },
}

describe("sidebar sync controller", () => {
  test("cached write happens before async remote fetch resolves", async () => {
    const events: string[] = []
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/cache", expanded: false }] },
        lastProject: { local: "/repo/cache" },
      }),
    })
    const originalSetItem = storage.setItem
    storage.setItem = (key, value) => {
      if (key === CURRENT_SERVER_STORAGE_KEY) events.push(`write:${JSON.parse(value).projects.local[0].worktree}`)
      originalSetItem(key, value)
    }
    let resolveFetch: (value: SidebarStateEnvelope) => void = () => undefined

    createSidebarSyncController({
      storage,
      scope: "local",
      debounceMs: 1,
      apiClient: {
        fetchState() {
          events.push("fetch:start")
          return new Promise<SidebarStateEnvelope>((resolve) => {
            resolveFetch = resolve
          })
        },
        uploadState() {
          throw new Error("unexpected upload")
        },
      },
    }).start()

    expect(events).toEqual(["write:/repo/cache", "fetch:start"])

    resolveFetch(localEnvelope)
    await Promise.resolve()

    expect(JSON.parse(storage.getItem(CURRENT_SERVER_STORAGE_KEY) ?? "{}").projects.local).toEqual([
      { worktree: "/repo/remote", expanded: true },
    ])
  })

  test("legacy key remains present after restore and upload", async () => {
    let notify = () => {}
    const storage = createStorage({
      [LEGACY_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/legacy", expanded: true }] },
        lastProject: { local: "/repo/legacy" },
      }),
    })
    const uploads: unknown[] = []

    restoreFromCache(storage, "local")
    expect(storage.getItem(LEGACY_SERVER_STORAGE_KEY)).not.toBeNull()

    const controller = createSidebarSyncController({
      storage,
      scope: "local",
      debounceMs: 1,
      subscribe(listener) {
        notify = listener
        return () => {
          notify = () => {}
        }
      },
      apiClient: {
        async fetchState() {
          return undefined
        },
        async uploadState(scope, baseVersion, payload) {
          uploads.push({ scope, baseVersion, payload })
          return { ...localEnvelope, version: 2, payload }
        },
      },
    })

    controller.start()
    notify()
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.stop()

    expect(uploads).toHaveLength(1)
    expect(storage.getItem(LEGACY_SERVER_STORAGE_KEY)).not.toBeNull()
  })

  test("current storage wins over legacy storage when both exist", () => {
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/current", expanded: true }] },
        lastProject: { local: "/repo/current" },
      }),
      [LEGACY_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/legacy", expanded: false }] },
        lastProject: { local: "/repo/legacy" },
      }),
    })

    restoreFromCache(storage, "local")

    expect(JSON.parse(storage.getItem(CURRENT_SERVER_STORAGE_KEY) ?? "{}").projects.local).toEqual([
      { worktree: "/repo/current", expanded: true },
    ])
    expect(JSON.parse(storage.getItem(CURRENT_SERVER_STORAGE_KEY) ?? "{}").lastProject.local).toBe("/repo/current")
  })

  test("remote fetch rejection keeps cache usable without logging raw failure", async () => {
    let notify = () => {}
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/cache", expanded: true }] },
        lastProject: { local: "/repo/cache" },
      }),
    })
    const uploads: unknown[] = []
    const originalError = console.error
    const errors: unknown[] = []
    console.error = (...args) => {
      errors.push(args)
    }

    try {
      const controller = createSidebarSyncController({
        storage,
        scope: "local",
        debounceMs: 1,
        subscribe(listener) {
          notify = listener
          return () => undefined
        },
        apiClient: {
          async fetchState() {
            throw new Error("token=secret raw payload")
          },
          async uploadState(scope, baseVersion, payload) {
            uploads.push({ scope, baseVersion, payload })
            return { ...localEnvelope, version: 2, payload }
          },
        },
      })

      controller.start()
      await Promise.resolve()
      notify()
      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.stop()
    } finally {
      console.error = originalError
    }

    expect(uploads).toEqual([
      {
        scope: "local",
        baseVersion: 0,
        payload: { schemaVersion: 1, projects: [{ worktree: "/repo/cache", expanded: true }], lastProject: "/repo/cache" },
      },
    ])
    expect(errors).toEqual([])
  })

  test("conflict response merges current envelope and retries upload once from current version", async () => {
    let notify = () => {}
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/local", expanded: false }] },
        lastProject: { local: "/repo/local" },
      }),
    })
    const uploads: unknown[] = []
    const current: SidebarStateEnvelope = {
      ...localEnvelope,
      version: 7,
      payload: { schemaVersion: 1, projects: [{ worktree: "/repo/remote", expanded: true }], lastProject: "/repo/remote" },
    }

    const controller = createSidebarSyncController({
      storage,
      scope: "local",
      debounceMs: 1,
      subscribe(listener) {
        notify = listener
        return () => undefined
      },
      apiClient: {
        async fetchState() {
          return undefined
        },
        async uploadState(scope, baseVersion, payload) {
          uploads.push({ scope, baseVersion, payload })
          if (uploads.length === 1) throw { error: "VersionConflict", current }
          return { ...current, version: 8, payload }
        },
      },
    })

    controller.start()
    notify()
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.stop()

    expect(uploads).toEqual([
      {
        scope: "local",
        baseVersion: 0,
        payload: { schemaVersion: 1, projects: [{ worktree: "/repo/local", expanded: false }], lastProject: "/repo/local" },
      },
      {
        scope: "local",
        baseVersion: 7,
        payload: { schemaVersion: 1, projects: [{ worktree: "/repo/local", expanded: false }], lastProject: "/repo/local" },
      },
    ])
  })

  test("debounce coalesces multiple notifications into one upload", async () => {
    let notify = () => {}
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/debounce", expanded: true }] },
      }),
    })
    const uploads: unknown[] = []

    const controller = createSidebarSyncController({
      storage,
      scope: "local",
      debounceMs: 5,
      subscribe(listener) {
        notify = listener
        return () => undefined
      },
      apiClient: {
        async fetchState() {
          return undefined
        },
        async uploadState(scope, baseVersion, payload) {
          uploads.push({ scope, baseVersion, payload })
          return { ...localEnvelope, version: 2, payload }
        },
      },
    })

    controller.start()
    notify()
    notify()
    notify()
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.stop()

    expect(uploads).toEqual([
      {
        scope: "local",
        baseVersion: 0,
        payload: { schemaVersion: 1, projects: [{ worktree: "/repo/debounce", expanded: true }] },
      },
    ])
  })

  test("uploaded JSON does not include forbidden persisted fields", async () => {
    let notify = () => {}
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: {
          local: [
            {
              worktree: "/repo/safe",
              expanded: true,
              list: ["http://localhost:4096"],
              password: "pw",
              token: "token",
              session: "session",
              prompt: "prompt",
              model: "model",
            },
          ],
        },
        lastProject: { local: "/repo/safe" },
        list: ["http://localhost:4096"],
        password: "pw",
        token: "token",
        session: "session",
        prompt: "prompt",
        model: "model",
      }),
    })
    let uploaded = ""

    const controller = createSidebarSyncController({
      storage,
      scope: "local",
      debounceMs: 1,
      subscribe(listener) {
        notify = listener
        return () => undefined
      },
      apiClient: {
        async fetchState() {
          return undefined
        },
        async uploadState(_scope, _baseVersion, payload) {
          uploaded = JSON.stringify(payload)
          return { ...localEnvelope, payload }
        },
      },
    })

    controller.start()
    notify()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(uploaded).toBe(JSON.stringify({ schemaVersion: 1, projects: [{ worktree: "/repo/safe", expanded: true }], lastProject: "/repo/safe" }))
    expect(uploaded).not.toContain("list")
    expect(uploaded).not.toContain("password")
    expect(uploaded).not.toContain("token")
    expect(uploaded).not.toContain("session")
    expect(uploaded).not.toContain("prompt")
    expect(uploaded).not.toContain("model")
  })
})
