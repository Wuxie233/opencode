import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"

type SettingsModule = typeof import("./settings")
type SettingsContext = ReturnType<SettingsModule["useSettings"]>

const storage = new MemoryStorage()
const serverState = new MockServerState()
let fetcher = mockServerStateFetch(serverState)
type TestGlobal = typeof globalThis & {
  __OPENCODE_TEST_CONTEXTS?: Map<string, unknown>
  __OPENCODE_TEST_FETCHER?: typeof fetch
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
  useServer: () => ({ current: { http: { url: "http://state.test" } } }),
}))

let SettingsProvider: SettingsModule["SettingsProvider"]
let useSettings: SettingsModule["useSettings"]

beforeAll(async () => {
  const mod = await import("./settings")
  SettingsProvider = mod.SettingsProvider
  useSettings = mod.useSettings
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  testContexts.set("Server", { current: { http: { url: "http://state.test" } } })
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
    expect(storage.getItem("settings.v3")).toContain('"fontSize":18')
    expect(result.settings.current.appearance.fontSize).toBe(18)
    expect(result.settings.appearance.fontSize()).toBe(18)
    expect(result.settings.keybinds.get("terminal.toggle")).toBe("ctrl+`")
    expect(result.settings.notifications.errors()).toBe(true)
    expect(result.settings.notifications.agent()).toBe(true)

    result.settings.appearance.setFontSize(19)
    await flushPersistence()

    const record = serverState.get("settings.v3")
    expect((record?.value as { appearance?: { fontSize?: number } }).appearance?.fontSize).toBe(19)
    result.dispose()
  })
})
