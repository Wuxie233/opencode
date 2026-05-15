import { createSidebarSyncClient } from "./api-client"
import { CURRENT_SERVER_STORAGE_KEY } from "./contract"
import { createSidebarSyncController, type SidebarSyncStorage } from "./sync-controller"

const defaultBaseUrl = "https://api.opencode.wuxie233.com"
const configKeys = ["sidebarSyncBaseUrl", "sidebarSyncNamespace", "sidebarSyncToken", "sidebarSyncScope"]

interface ChromeStorageArea {
  get(keys: readonly string[], callback: (items: Record<string, unknown>) => void): void
}

interface ChromeLike {
  readonly storage?: {
    readonly local?: ChromeStorageArea
  }
}

interface SidebarSyncConfig {
  readonly baseUrl: string
  readonly namespace: string
  readonly token: string
  readonly scope: string
}

function isWindowLike(value: typeof globalThis): value is typeof globalThis & Window {
  return typeof value.addEventListener === "function" && typeof value.removeEventListener === "function"
}

function getChrome(value: typeof globalThis) {
  return "chrome" in value ? (value.chrome as ChromeLike | undefined) : undefined
}

export function readSidebarSyncConfig(items: Record<string, unknown>): SidebarSyncConfig | undefined {
  if (typeof items.sidebarSyncNamespace !== "string" || typeof items.sidebarSyncToken !== "string" || typeof items.sidebarSyncScope !== "string") return undefined

  return {
    baseUrl: typeof items.sidebarSyncBaseUrl === "string" && items.sidebarSyncBaseUrl.length > 0 ? items.sidebarSyncBaseUrl : defaultBaseUrl,
    namespace: items.sidebarSyncNamespace,
    token: items.sidebarSyncToken,
    scope: items.sidebarSyncScope,
  }
}

export function subscribeToCurrentServerStorage(listener: () => void, target: typeof globalThis = globalThis) {
  const storagePrototype = "Storage" in target ? target.Storage?.prototype : undefined
  const originalSetItem = storagePrototype?.setItem
  const onStorage = (event: StorageEvent) => {
    if (event.key === CURRENT_SERVER_STORAGE_KEY) listener()
  }

  if (isWindowLike(target)) target.addEventListener("storage", onStorage)
  if (storagePrototype && originalSetItem) {
    storagePrototype.setItem = function (key: string, value: string) {
      originalSetItem.call(this, key, value)
      if (key === CURRENT_SERVER_STORAGE_KEY) listener()
    }
  }

  return () => {
    if (isWindowLike(target)) target.removeEventListener("storage", onStorage)
    if (storagePrototype && originalSetItem && storagePrototype.setItem !== originalSetItem) storagePrototype.setItem = originalSetItem
  }
}

export function createLocalStorageAdapter(storage: Storage): SidebarSyncStorage {
  return {
    getItem(key) {
      return storage.getItem(key)
    },
    setItem(key, value) {
      storage.setItem(key, value)
    },
  }
}

export function startExtensionContent(target: typeof globalThis = globalThis) {
  const chromeStorage = getChrome(target)?.storage?.local
  if (!chromeStorage || !("localStorage" in target) || !target.localStorage) return

  chromeStorage.get(configKeys, (items) => {
    const config = readSidebarSyncConfig(items)
    if (!config) return

    const client = createSidebarSyncClient({ baseUrl: config.baseUrl, token: config.token })
    createSidebarSyncController({
      storage: createLocalStorageAdapter(target.localStorage),
      scope: config.scope,
      subscribe: (listener) => subscribeToCurrentServerStorage(listener, target),
      apiClient: {
        fetchState(scope) {
          return client.getState(config.namespace, scope)
        },
        uploadState(scope, baseVersion, payload) {
          return client.putState(config.namespace, scope, { baseVersion, payload })
        },
      },
    }).start()
  })
}

startExtensionContent()
