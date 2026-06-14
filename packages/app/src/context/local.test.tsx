import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"

type LocalModule = typeof import("./local")
type LocalContext = ReturnType<LocalModule["useLocal"]>

const directory = "/workspace/a"
const sessionID = "session-1"
const storageName = `workspace:model-selection/${encodeURIComponent(directory)}`
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

const modelEntry = {
  provider: { id: "provider" },
  id: "model",
  variants: { fast: {}, slow: {} },
}

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

mock.module("@solidjs/router", () => ({
  useParams: () => ({ id: sessionID, dir: "" }),
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
}))

mock.module("@/context/server", () => ({
  useServer: () => ({ current: { http: { url: "http://state.test" } } }),
}))

mock.module("./sdk", () => ({
  useSDK: () => ({ directory }),
}))

mock.module("./sync", () => ({
  useSync: () => ({
    data: {
      agent: [{ name: "agent-a", mode: "primary", hidden: false, model: { providerID: "provider", modelID: "model" } }],
      config: {},
    },
  }),
}))

mock.module("@/hooks/use-providers", () => ({
  useProviders: () => ({
    all: () => [
      {
        id: "provider",
        models: { model: { id: "model" } },
      },
    ],
    connected: () => [
      {
        id: "provider",
        models: { model: { id: "model" } },
      },
    ],
    default: () => ({ provider: "model" }),
  }),
}))

mock.module("@/context/models", () => ({
  useModels: () => ({
    ready: () => true,
    find: (input: { providerID: string; modelID: string }) =>
      input.providerID === "provider" && input.modelID === "model" ? modelEntry : undefined,
    list: () => [modelEntry],
    recent: {
      list: () => [],
      push() {},
    },
    setVisibility() {},
    visible: () => true,
  }),
}))

let LocalProvider: LocalModule["LocalProvider"]
let useLocal: LocalModule["useLocal"]

beforeAll(async () => {
  const mod = await import("./local")
  LocalProvider = mod.LocalProvider
  useLocal = mod.useLocal
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

async function waitFor(input: () => boolean) {
  for (const _ of Array.from({ length: 10 })) {
    if (input()) return
    await flushPersistence()
  }
  expect(input()).toBe(true)
}

async function mountLocal() {
  let local: LocalContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    LocalProvider({ children: undefined })
    local = useLocal()
  })
  await waitFor(() => local?.model.variant.selected() === "fast")
  return { local: local!, dispose }
}

describe("local context workspace model-selection server persistence", () => {
  test("hydrates model choices for a fresh local profile and writes back per workspace", async () => {
    serverState.seed(storageName, {
      value: {
        session: {
          [sessionID]: {
            agent: "agent-a",
            model: { providerID: "provider", modelID: "model" },
            variant: "fast",
          },
        },
      },
      version: "v1",
      updated_at: 10,
    })

    const result = await mountLocal()

    expect(result.local.agent.current()?.name).toBe("agent-a")
    expect(result.local.model.current()?.id).toBe("model")
    expect(result.local.model.variant.selected()).toBe("fast")
    expect(storage.key(0)).toContain("opencode.workspace.")
    expect(storage.key(0)).toContain(":workspace:model-selection")

    result.local.model.variant.set("slow")
    await flushPersistence()

    const record = serverState.get(storageName)
    const value = record?.value as { session?: Record<string, { variant?: string | null }> }
    expect(value.session?.[sessionID]?.variant).toBe("slow")
    result.dispose()
  })
})
