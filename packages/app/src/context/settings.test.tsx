import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"
import { ScopedKey } from "../utils/server-scope"
import { registerWebStateServerResolver, resetWebStateServerResolvers } from "@/utils/web-state"

type SettingsModule = typeof import("./settings")
type SettingsContext = ReturnType<SettingsModule["useSettings"]>
type PersistTestingType = typeof import("@/utils/persist").PersistTesting

const SCOPE = "http://state.test"
const SETTINGS_LOCAL_KEY = `opencode.global.dat:${ScopedKey.from(SCOPE as never, "settings.v3")}`
const SETTINGS_LOCAL_SCOPED_KEY = "opencode.global.dat:settings.v3"

let currentScope = SCOPE
const storage = new MemoryStorage()
const serverState = new MockServerState()
let fetcher = mockServerStateFetch(serverState)
let unregisterResolver = () => {}

type TestGlobal = typeof globalThis & {
  __OPENCODE_TEST_CONTEXTS?: Map<string, unknown>
  __OPENCODE_TEST_FETCHER?: typeof fetch
  __OPENCODE_TEST_SERVER?: unknown
}
const testGlobal = globalThis as TestGlobal
testGlobal.__OPENCODE_TEST_FETCHER = fetcher
const testContexts = (testGlobal.__OPENCODE_TEST_CONTEXTS ??= new Map<string, unknown>())

type ContextInput = { name: string; init: (props?: Record<string, unknown>) => unknown }
type ContextProps = { children?: unknown }

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: ContextInput) => {
    let value: unknown
    return {
      provider: (props: ContextProps) => {
        value = input.init(props)
        testContexts.set(input.name, value)
        return props.children
      },
      use: () => testContexts.get(input.name) ?? value,
    }
  },
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
}))

mock.module("@/context/server", () => ({
  useServer: () => testGlobal.__OPENCODE_TEST_SERVER,
  ServerConnection: { key: (conn: { http: { url: string } }) => conn.http.url },
}))

let SettingsProvider: SettingsModule["SettingsProvider"]
let useSettings: SettingsModule["useSettings"]
let persistTesting: PersistTestingType

beforeAll(async () => {
  const persist = await import("@/utils/persist")
  persistTesting = persist.PersistTesting
  const mod = await import("./settings")
  SettingsProvider = mod.SettingsProvider
  useSettings = mod.useSettings
})

beforeEach(() => {
  resetWebStateServerResolvers()
  persistTesting?.resetCache()
  currentScope = SCOPE
  storage.reset()
  serverState.reset()
  fetcher = mockServerStateFetch(serverState)
  unregisterResolver = registerWebStateServerResolver((scope) =>
    scope === currentScope ? { url: "http://state.test", fetch: fetcher } : undefined,
  )
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  testGlobal.__OPENCODE_TEST_SERVER = { scope: () => currentScope }
  testContexts.clear()
  installLocalStorage(storage)
})

async function mountSettings() {
  let settings: SettingsContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    SettingsProvider({ children: undefined })
    settings = useSettings()
  })
  await settings?.ready.promise
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { settings: settings!, dispose }
}

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("settings server persistence", () => {
  test("hydrates settings.v3 from server and keeps fallback defaults", async () => {
    serverState.seed("settings.v3", {
      value: {
        appearance: { fontSize: 18 },
        keybinds: { "terminal.toggle": "ctrl+`" },
        notifications: { errors: true },
      },
      version: "v1",
      updated_at: 5,
    })

    const result = await mountSettings()

    expect(serverState.calls.get).toBeGreaterThan(0)
    expect(storage.getItem(SETTINGS_LOCAL_KEY)).toContain('"fontSize":18')
    expect(result.settings.current.appearance.fontSize).toBe(18)
    expect(result.settings.keybinds.get("terminal.toggle")).toBe("ctrl+`")
    expect(result.settings.current.notifications.errors).toBe(true)
    expect(result.settings.current.notifications.agent).toBe(true)
    result.dispose()
  })

  test("writes settings.v3 changes through to the server", async () => {
    const result = await mountSettings()

    result.settings.appearance.setFontSize(19)
    await flushPersistence()

    expect(result.settings.current.appearance.fontSize).toBe(19)
    const record = serverState.get("settings.v3")
    expect((record?.value as { appearance?: { fontSize?: number } }).appearance?.fontSize).toBe(19)
    result.dispose()
  })

  test("migrates the legacy raw settings.v3 localStorage key into the prefixed store on local scope", async () => {
    currentScope = "local"
    storage.setItem("settings.v3", JSON.stringify({ appearance: { fontSize: 21 } }))

    const result = await mountSettings()
    await flushPersistence()

    expect(result.settings.current.appearance.fontSize).toBe(21)
    expect(storage.getItem("settings.v3")).toBeNull()
    expect(storage.getItem(SETTINGS_LOCAL_SCOPED_KEY)).toContain('"fontSize":21')
    result.dispose()
  })

  test("hydrates local-scope settings.v3 from the canonical server", async () => {
    currentScope = "local"
    serverState.seed("settings.v3", { value: { appearance: { fontSize: 22 } }, version: "v1", updated_at: 6 })

    const result = await mountSettings()

    expect(result.settings.current.appearance.fontSize).toBe(22)
    expect(serverState.calls.get).toBeGreaterThan(0)
    expect(storage.getItem(SETTINGS_LOCAL_SCOPED_KEY)).toContain('"fontSize":22')
    result.dispose()
  })
})
