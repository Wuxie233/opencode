import { afterEach, describe, expect, test } from "bun:test"
import { CURRENT_SERVER_STORAGE_KEY } from "./contract"

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
    clear() {
      values.clear()
    },
  }
}

class FakeStorage implements Storage {
  readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

async function importFresh() {
  return import(`./extension-content?test=${crypto.randomUUID()}`)
}

const originalChrome = "chrome" in globalThis ? (globalThis as { readonly chrome?: unknown }).chrome : undefined
const originalLocalStorage = globalThis.localStorage

function storageEvent(key: string) {
  const event = new Event("storage")
  Object.defineProperty(event, "key", { value: key })
  return event
}

afterEach(() => {
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage })
})

describe("extension content script", () => {
  test("auto-runs at import and restores cached payload synchronously", async () => {
    const events: string[] = []
    const storage = createStorage({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { local: [{ worktree: "/repo/cache", expanded: true }] },
        lastProject: { local: "/repo/cache" },
      }),
    })
    const originalSetItem = storage.setItem
    storage.setItem = (key, value) => {
      if (key === CURRENT_SERVER_STORAGE_KEY) events.push(`local:${JSON.parse(value).projects.local[0].worktree}`)
      originalSetItem(key, value)
    }

    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: {
            get(keys: string[], callback: (items: Record<string, string>) => void) {
              events.push(`get:${keys.join(",")}`)
              callback({ sidebarSyncNamespace: "personal", sidebarSyncToken: "device-token", sidebarSyncScope: "local" })
            },
          },
        },
      },
    })

    await importFresh()

    expect(events.slice(0, 2)).toEqual([
      "get:sidebarSyncBaseUrl,sidebarSyncNamespace,sidebarSyncToken,sidebarSyncScope",
      "local:/repo/cache",
    ])
  })

  test("storage event subscription forwards only the current persisted key", async () => {
    const notifications: string[] = []
    const module = await importFresh()
    const target = Object.assign(new EventTarget(), { Storage: FakeStorage, localStorage: new FakeStorage() }) as unknown as typeof globalThis
    const unsubscribe = module.subscribeToCurrentServerStorage(() => notifications.push("notify"), target)

    target.dispatchEvent(storageEvent("unrelated"))
    target.dispatchEvent(storageEvent(CURRENT_SERVER_STORAGE_KEY))
    target.localStorage.setItem("unrelated", "value")
    target.localStorage.setItem(CURRENT_SERVER_STORAGE_KEY, JSON.stringify({ projects: { local: [] } }))

    unsubscribe()

    expect(notifications).toEqual(["notify", "notify"])
  })

  test("builds controller config from chrome storage with configurable base URL", async () => {
    const module = await importFresh()

    expect(
      module.readSidebarSyncConfig({
        sidebarSyncNamespace: "personal",
        sidebarSyncToken: "device-token",
        sidebarSyncScope: "staging",
        sidebarSyncBaseUrl: "https://staging.example.test/",
      }),
    ).toEqual({
      baseUrl: "https://staging.example.test/",
      namespace: "personal",
      scope: "staging",
      token: "device-token",
    })

    expect(
      module.readSidebarSyncConfig({
        sidebarSyncNamespace: "personal",
        sidebarSyncToken: "device-token",
        sidebarSyncScope: "local",
      }),
    ).toEqual({
      baseUrl: "https://api.opencode.wuxie233.com",
      namespace: "personal",
      scope: "local",
      token: "device-token",
    })
  })
})
