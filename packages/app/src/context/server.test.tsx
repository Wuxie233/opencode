import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"

type ServerModule = typeof import("./server")
type ServerContext = ReturnType<ServerModule["useServer"]>
type ServerKey = string & { _brand: "Key" }

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
  usePlatform: () => ({
    platform: "web",
    fetch: testGlobal.__OPENCODE_TEST_FETCHER,
    getDefaultServer: async () => "http://state.test",
  }),
}))

mock.module("@/utils/server-health", () => ({
  useCheckServerHealth: () => async () => ({ healthy: true }),
}))

let ServerProvider: ServerModule["ServerProvider"]
let useServer: ServerModule["useServer"]

beforeAll(async () => {
  const mod = await import("./server")
  ServerProvider = mod.ServerProvider
  useServer = mod.useServer
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  testContexts.clear()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  installLocalStorage(storage)
})

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const serverKey = (value: string) => value as ServerKey

async function mountServer() {
  let server: ServerContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    ServerProvider({
      defaultServer: serverKey("http://fallback.test"),
      disableHealthCheck: true,
      servers: [],
      children: undefined,
    })
    server = useServer()
  })
  await flushPersistence()
  await flushPersistence()
  return { server: server!, dispose }
}

describe("server context server persistence", () => {
  test("hydrates active server, project metadata, and last project from server state", async () => {
    serverState.seed("server", {
      value: {
        active: "http://remote.test",
        list: [{ type: "http", http: { url: "http://remote.test" } }],
        projects: {
          "http://remote.test": [{ worktree: "/repo", expanded: false }],
        },
        lastProject: {
          "http://remote.test": "/repo",
        },
      },
      version: "v1",
      updated_at: 8,
    })

    const result = await mountServer()

    expect(result.server.ready()).toBe(true)
    expect(String(result.server.key)).toBe("http://remote.test")
    expect(result.server.list.map((item) => item.http.url)).toContain("http://remote.test")
    expect(result.server.projects.list()).toEqual([{ worktree: "/repo", expanded: false }])
    expect(result.server.projects.last()).toBe("/repo")

    result.server.projects.touch("/repo-next")
    await flushPersistence()

    const record = serverState.get("server")
    expect((record?.value as { lastProject?: Record<string, string> }).lastProject?.["http://remote.test"]).toBe(
      "/repo-next",
    )
    result.dispose()
  })
})
