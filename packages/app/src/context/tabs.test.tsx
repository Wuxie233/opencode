import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"
import { ScopedKey } from "../utils/server-scope"
import { registerWebStateServerResolver, resetWebStateServerResolvers } from "@/utils/web-state"

type TabsModule = typeof import("./tabs")
type TabsContext = ReturnType<TabsModule["useTabs"]>
type PersistTestingType = typeof import("@/utils/persist").PersistTesting

const SCOPE = "http://state.test"
const TABS_LOCAL_KEY = `opencode.global.dat:${ScopedKey.from(SCOPE as never, "tabs")}`
const TABS_CANONICAL_LOCAL_KEY = "opencode.global.dat:tabs"

const storage = new MemoryStorage()
const serverState = new MockServerState()
let fetcher = mockServerStateFetch(serverState)
let currentScope = SCOPE
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

const platformModule = () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
})
mock.module("@/context/platform", platformModule)
mock.module("./platform", platformModule)

const serverModule = () => ({
  useServer: () => testGlobal.__OPENCODE_TEST_SERVER,
  ServerConnection: {
    key: (conn: { http: { url: string } }) => conn.http.url,
  },
})
mock.module("@/context/server", serverModule)
mock.module("./server", serverModule)

mock.module("@solidjs/router", () => ({
  useParams: () => ({}),
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: "/", query: {} }),
}))

mock.module("@/components/titlebar-session-events", () => ({
  SessionTabsRemovedDetail: class {},
}))

let TabsProvider: TabsModule["TabsProvider"]
let useTabs: TabsModule["useTabs"]
let persistTesting: PersistTestingType

beforeAll(async () => {
  const persist = await import("@/utils/persist")
  persistTesting = persist.PersistTesting
  const mod = await import("./tabs")
  TabsProvider = mod.TabsProvider
  useTabs = mod.useTabs
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
  testGlobal.__OPENCODE_TEST_SERVER = {
    key: SCOPE,
    scope: () => currentScope,
    list: [{ type: "http", http: { url: SCOPE } }],
    setActive: () => {},
  }
  testContexts.clear()
  installLocalStorage(storage)
})

async function mountTabs() {
  let tabs: TabsContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    TabsProvider({ children: undefined })
    tabs = useTabs()
  })
  await tabs?.ready.promise
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { tabs: tabs!, dispose }
}

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("tabs server persistence", () => {
  test("hydrates the tabs group from the server", async () => {
    serverState.seed("tabs", {
      value: [{ type: "session", server: SCOPE, dirBase64: "ZA==", sessionId: "s1" }],
      version: "v1",
      updated_at: 1,
    })

    const result = await mountTabs()

    expect(serverState.calls.get).toBeGreaterThan(0)
    expect(result.tabs.store).toHaveLength(1)
    expect(result.tabs.store[0]).toMatchObject({ type: "session", sessionId: "s1", server: SCOPE })
    expect(storage.getItem(TABS_LOCAL_KEY)).toContain('"sessionId":"s1"')
    result.dispose()
  })

  test("writes tab changes through to the server", async () => {
    serverState.seed("tabs", {
      value: [{ type: "session", server: SCOPE, dirBase64: "ZA==", sessionId: "s1" }],
      version: "v1",
      updated_at: 1,
    })

    const result = await mountTabs()

    result.tabs.addSessionTab({ server: SCOPE as never, dirBase64: "ZDI=", sessionId: "s2" })
    await flushPersistence()

    const record = serverState.get("tabs")
    const value = record?.value as Array<{ sessionId: string }>
    expect(value).toHaveLength(2)
    expect(value.map((tab) => tab.sessionId)).toEqual(["s1", "s2"])
    result.dispose()
  })

  test("hydrates local-scope tabs from the canonical server", async () => {
    currentScope = "local"
    serverState.seed("tabs", {
      value: [{ type: "session", server: SCOPE, dirBase64: "ZA==", sessionId: "local-s1" }],
      version: "v1",
      updated_at: 2,
    })

    const result = await mountTabs()

    expect(serverState.calls.get).toBeGreaterThan(0)
    expect(result.tabs.store[0]).toMatchObject({ type: "session", sessionId: "local-s1" })
    expect(storage.getItem(TABS_CANONICAL_LOCAL_KEY)).toContain('"sessionId":"local-s1"')
    result.dispose()
  })
})
