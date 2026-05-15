// ==UserScript==
// @name         OpenCode Sidebar Sync
// @namespace    https://opencode.wuxie233.com/
// @version      0.0.0
// @description  Sync OpenCode sidebar state from browsers without extension support.
// @match        https://opencode.wuxie233.com/*
// @match        https://app.opencode.ai/*
// @match        https://*.dev.opencode.ai/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

import { createSidebarSyncClient } from "./api-client"
import { CURRENT_SERVER_STORAGE_KEY } from "./contract"
import { createSidebarSyncController, type SidebarSyncController, type SidebarSyncStorage } from "./sync-controller"

export const USERSCRIPT_VERSION = "0.0.0"
export const CONFIG_STORAGE_KEY = "opencode.sidebarSync.config"

const defaultBaseUrl = "https://api.opencode.wuxie233.com"
const fallbackDiagnostics = ["GM storage unavailable; using localStorage fallback", "GM_xmlhttpRequest unavailable; using fetch fallback"]

export interface UserscriptConfig {
  readonly baseUrl: string
  readonly namespace: string
  readonly token: string
  readonly syncIntervalMs?: number
}

export interface UserscriptDiagnostic {
  readonly enabled: boolean
  readonly lastError: string | undefined
  readonly lastSyncAt: string | undefined
  readonly baseUrl: string
  readonly namespace: string
  readonly scope: string
  readonly version: string
}

interface UserscriptStorageApi {
  readonly GM_getValue?: (key: string, defaultValue?: string | null) => unknown
  readonly GM_setValue?: (key: string, value: string) => unknown
}

interface UserscriptRequestDetails {
  readonly method?: string
  readonly url: string
  readonly headers?: Record<string, string>
  readonly data?: string
  readonly onload: (response: { readonly status: number; readonly statusText: string; readonly responseText: string; readonly responseHeaders?: string }) => void
  readonly onerror: (error: unknown) => void
}

interface UserscriptRequestApi {
  readonly GM_xmlhttpRequest?: (details: UserscriptRequestDetails) => void
}

type UserscriptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface UserscriptWindowLike {
  readonly localStorage: Storage | SidebarSyncStorage
  readonly location: Pick<Location, "protocol" | "host" | "hostname" | "origin">
  addEventListener(type: "storage", listener: (event: StorageEvent) => void): void
  removeEventListener(type: "storage", listener: (event: StorageEvent) => void): void
  __OPENCODE_SIDEBAR_SYNC__?: UserscriptDiagnostic
}

interface UserscriptRuntime {
  readonly window: UserscriptWindowLike
  readonly fetch?: UserscriptFetch
  readonly GM_getValue?: (key: string, defaultValue?: string | null) => unknown
  readonly GM_setValue?: (key: string, value: string) => unknown
  readonly GM_xmlhttpRequest?: (details: UserscriptRequestDetails) => void
}

declare global {
  interface Window {
    __OPENCODE_SIDEBAR_SYNC__?: UserscriptDiagnostic
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isConfig(value: unknown): value is UserscriptConfig {
  return isRecord(value) && typeof value.namespace === "string" && typeof value.token === "string"
}

function parseConfig(value: string | null) {
  if (!value) return undefined

  try {
    const config = JSON.parse(value)
    if (!isConfig(config)) return undefined
    return {
      baseUrl: typeof config.baseUrl === "string" && config.baseUrl.length > 0 ? config.baseUrl : defaultBaseUrl,
      namespace: config.namespace,
      token: config.token,
      ...(typeof config.syncIntervalMs === "number" ? { syncIntervalMs: config.syncIntervalMs } : {}),
    }
  } catch {
    return undefined
  }
}

function getGlobalRuntime(): UserscriptRuntime | undefined {
  if (typeof window === "undefined" || !window.localStorage) return undefined

  return {
    window,
    fetch,
    ...(typeof (globalThis as UserscriptStorageApi).GM_getValue === "function" ? { GM_getValue: (globalThis as UserscriptStorageApi).GM_getValue } : {}),
    ...(typeof (globalThis as UserscriptStorageApi).GM_setValue === "function" ? { GM_setValue: (globalThis as UserscriptStorageApi).GM_setValue } : {}),
    ...(typeof (globalThis as UserscriptRequestApi).GM_xmlhttpRequest === "function"
      ? { GM_xmlhttpRequest: (globalThis as UserscriptRequestApi).GM_xmlhttpRequest }
      : {}),
  }
}

function readStoredValue(key: string, runtime: UserscriptStorageApi, localStorage?: Storage | SidebarSyncStorage) {
  if (runtime.GM_getValue) {
    const value = runtime.GM_getValue(key, null)
    return typeof value === "string" ? value : null
  }

  return localStorage?.getItem(key) ?? null
}

function getResponseHeaders(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries())
}

function parseResponseHeaders(headers: string | undefined) {
  if (!headers) return undefined

  return Object.fromEntries(
    headers
      .split(/\r?\n/)
      .map((line) => line.split(":"))
      .filter((parts) => parts.length >= 2)
      .map((parts) => [parts[0]?.trim() ?? "", parts.slice(1).join(":").trim()]),
  )
}

function createDiagnostic(config: UserscriptConfig, scope: string, lastError: string | undefined): UserscriptDiagnostic {
  return {
    enabled: true,
    lastError,
    lastSyncAt: undefined,
    baseUrl: config.baseUrl,
    namespace: config.namespace,
    scope,
    version: USERSCRIPT_VERSION,
  }
}

export function readUserscriptConfig(runtime: UserscriptStorageApi & { readonly localStorage?: Storage | SidebarSyncStorage }) {
  return parseConfig(readStoredValue(CONFIG_STORAGE_KEY, runtime, runtime.localStorage))
}

export function saveUserscriptConfig(config: UserscriptConfig, runtime: UserscriptStorageApi & { readonly localStorage?: Storage | SidebarSyncStorage }) {
  const value = JSON.stringify(config)

  if (runtime.GM_setValue) {
    runtime.GM_setValue(CONFIG_STORAGE_KEY, value)
    return
  }

  runtime.localStorage?.setItem(CONFIG_STORAGE_KEY, value)
}

export function createUserscriptFetch(runtime: UserscriptRequestApi & { readonly fetch?: UserscriptFetch }): UserscriptFetch {
  if (!runtime.GM_xmlhttpRequest) return runtime.fetch ?? fetch

  return async (input, init) =>
    new Promise<Response>((resolve, reject) => {
      runtime.GM_xmlhttpRequest?.({
        method: init?.method ?? "GET",
        url: String(input),
        headers: getResponseHeaders(init?.headers),
        ...(init?.body === undefined ? {} : { data: String(init.body) }),
        onload(response) {
          resolve(new Response(response.responseText, { status: response.status, statusText: response.statusText, headers: parseResponseHeaders(response.responseHeaders) }))
        },
        onerror(error) {
          reject(error)
        },
      })
    })
}

export function getUserscriptScope(target: UserscriptWindowLike) {
  if (target.location.protocol === "http:" && (target.location.hostname === "localhost" || target.location.hostname === "127.0.0.1")) return "local"
  return target.location.origin || target.location.host
}

export function createLocalStorageAdapter(storage: Storage | SidebarSyncStorage): SidebarSyncStorage {
  return {
    getItem(key) {
      return storage.getItem(key)
    },
    setItem(key, value) {
      storage.setItem(key, value)
    },
  }
}

export function subscribeToCurrentServerStorage(listener: () => void, target: UserscriptWindowLike, intervalMs = 1000) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CURRENT_SERVER_STORAGE_KEY) listener()
  }
  const timer = setInterval(listener, intervalMs)

  target.addEventListener("storage", onStorage)

  return () => {
    clearInterval(timer)
    target.removeEventListener("storage", onStorage)
  }
}

export function startUserscriptSync(options: { readonly config?: UserscriptConfig; readonly runtime?: UserscriptRuntime } = {}): SidebarSyncController {
  const runtime = options.runtime ?? getGlobalRuntime()
  if (!runtime) return { start() {}, stop() {} }

  const config = options.config ?? readUserscriptConfig({ ...runtime, localStorage: runtime.window.localStorage })
  if (!config) return { start() {}, stop() {} }

  const scope = getUserscriptScope(runtime.window)
  const diagnostic = createDiagnostic(
    config,
    scope,
    [
      ...(runtime.GM_getValue && runtime.GM_setValue ? [] : [fallbackDiagnostics[0]]),
      ...(runtime.GM_xmlhttpRequest ? [] : [fallbackDiagnostics[1]]),
    ].join("; ") || undefined,
  )
  const client = createSidebarSyncClient({ baseUrl: config.baseUrl, token: config.token, fetch: createUserscriptFetch(runtime) })
  const controller = createSidebarSyncController({
    storage: createLocalStorageAdapter(runtime.window.localStorage),
    scope,
    ...(config.syncIntervalMs === undefined ? {} : { debounceMs: config.syncIntervalMs }),
    subscribe: (listener) => subscribeToCurrentServerStorage(listener, runtime.window, config.syncIntervalMs),
    apiClient: {
      async fetchState(scope) {
        const envelope = await client.getState(config.namespace, scope)
        if (envelope) runtime.window.__OPENCODE_SIDEBAR_SYNC__ = { ...diagnostic, lastSyncAt: new Date().toISOString() }
        return envelope
      },
      async uploadState(scope, baseVersion, payload) {
        const envelope = await client.putState(config.namespace, scope, { baseVersion, payload })
        runtime.window.__OPENCODE_SIDEBAR_SYNC__ = { ...diagnostic, lastSyncAt: new Date().toISOString() }
        return envelope
      },
    },
  })

  runtime.window.__OPENCODE_SIDEBAR_SYNC__ = diagnostic
  controller.start()

  return controller
}

startUserscriptSync()
