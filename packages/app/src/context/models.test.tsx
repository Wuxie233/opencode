import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"

type ModelsModule = typeof import("./models")
type ModelsContext = ReturnType<ModelsModule["useModels"]>

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

mock.module("@/hooks/use-providers", () => ({
  useProviders: () => ({
    connected: () => [
      {
        id: "provider",
        models: {
          model: {
            id: "model",
            name: "Model",
            family: "model",
            release_date: new Date().toISOString(),
          },
        },
      },
    ],
  }),
}))

let ModelsProvider: ModelsModule["ModelsProvider"]
let useModels: ModelsModule["useModels"]

beforeAll(async () => {
  const mod = await import("./models")
  ModelsProvider = mod.ModelsProvider
  useModels = mod.useModels
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  testContexts.set("Server", { current: { http: { url: "http://state.test" } } })
  installLocalStorage(storage)
})

async function mountModels() {
  let models: ModelsContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    ModelsProvider({ children: undefined })
    models = useModels()
  })
  await models?.ready.promise
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { models: models!, dispose }
}

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("models server persistence", () => {
  test("hydrates recent and variant model preferences from server", async () => {
    serverState.seed("model", {
      value: {
        user: [],
        recent: [{ providerID: "provider", modelID: "model" }],
        variant: { "provider/model": "fast" },
      },
      version: "v1",
      updated_at: 6,
    })

    const result = await mountModels()

    expect(result.models.recent.list()[0]).toEqual({ providerID: "provider", modelID: "model" })
    expect(result.models.variant.get({ providerID: "provider", modelID: "model" })).toBe("fast")

    result.models.variant.set({ providerID: "provider", modelID: "model" }, "accurate")
    await flushPersistence()

    const record = serverState.get("model")
    expect((record?.value as { variant?: Record<string, string> }).variant?.["provider/model"]).toBe("accurate")
    result.dispose()
  })
})
