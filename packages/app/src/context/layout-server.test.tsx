import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"

type LayoutModule = typeof import("./layout")
type LayoutContext = ReturnType<LayoutModule["useLayout"]>

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

mock.module("./platform", () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
}))

mock.module("./server", () => ({
  useServer: () => ({
    current: { http: { url: "http://state.test" } },
    projects: {
      list: () => [],
      open() {},
      close() {},
      expand() {},
      collapse() {},
      move() {},
      last() {},
      touch() {},
    },
  }),
}))

mock.module("./global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      project: {
        update: async () => ({}),
      },
    },
  }),
}))

mock.module("./global-sync", () => ({
  useGlobalSync: () => ({
    ready: true,
    data: { project: [] },
    child: () => [{ project: undefined, icon: undefined }],
    project: {
      loadSessions: async () => {},
      icon() {},
      meta() {},
    },
  }),
}))

let LayoutProvider: LayoutModule["LayoutProvider"]
let useLayout: LayoutModule["useLayout"]

beforeAll(async () => {
  const mod = await import("./layout")
  LayoutProvider = mod.LayoutProvider
  useLayout = mod.useLayout
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  testContexts.clear()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  installLocalStorage(storage)
})

async function mountLayout() {
  let layout: LayoutContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    LayoutProvider({ children: undefined })
    layout = useLayout()
  })
  await layout?.ready.promise
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { layout: layout!, dispose }
}

describe("layout context server persistence", () => {
  test("hydrates session tabs, view scroll, handoff, and layout open state from server state", async () => {
    serverState.seed("layout", {
      value: {
        sidebar: { opened: true, width: 444, workspaces: {}, workspacesDefault: false },
        terminal: { height: 500, opened: true },
        sessionTabs: {
          "dir/session": { all: ["context"], active: "context" },
        },
        sessionView: {
          "dir/session": { scroll: { context: { x: 12, y: 34 } }, reviewOpen: ["file://README.md"] },
        },
        handoff: { tabs: { dir: "/repo", id: "session", at: 7 } },
      },
      version: "v1",
      updated_at: 9,
    })

    const result = await mountLayout()
    const tabs = result.layout.tabs("dir/session")
    const view = result.layout.view("dir/session")

    expect(result.layout.sidebar.opened()).toBe(true)
    expect(result.layout.sidebar.width()).toBe(444)
    expect(view.terminal.opened()).toBe(true)
    expect(tabs.active()).toBe("context")
    expect(tabs.all()).toEqual(["context"])
    expect(view.scroll("context")).toEqual({ x: 12, y: 34 })
    expect(view.review.open()).toEqual(["file://README.md"])
    expect(result.layout.handoff.tabs()).toEqual({ dir: "/repo", id: "session", at: 7 })

    result.layout.session.resize(700)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const record = serverState.get("layout")
    expect((record?.value as { session?: { width?: number } }).session?.width).toBe(700)
    result.dispose()
  })
})
