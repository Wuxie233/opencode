import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createRoot } from "solid-js"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"

type PermissionModule = typeof import("./permission")
type PermissionContext = ReturnType<PermissionModule["usePermission"]>

const directory = "/repo"
const directoryKey = `${base64Encode(directory)}/*`
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

mock.module("@solidjs/router", () => ({
  useParams: () => ({ dir: base64Encode(directory) }),
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
}))

mock.module("@/context/server", () => ({
  useServer: () => ({ current: { http: { url: "http://state.test" } } }),
}))

mock.module("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    event: { listen: () => () => undefined },
    client: {
      permission: {
        respond: async () => undefined,
        list: async () => ({ data: [] }),
      },
    },
  }),
}))

mock.module("./global-sync", () => ({
  useGlobalSync: () => ({
    child: () => [{ config: { permission: "ask" }, session: [] }],
  }),
}))

let PermissionProvider: PermissionModule["PermissionProvider"]
let usePermission: PermissionModule["usePermission"]

beforeAll(async () => {
  const mod = await import("./permission")
  PermissionProvider = mod.PermissionProvider
  usePermission = mod.usePermission
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  testContexts.set("Server", { current: { http: { url: "http://state.test" } } })
  installLocalStorage(storage)
})

async function mountPermission() {
  let permission: PermissionContext | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    PermissionProvider({ children: undefined })
    permission = usePermission()
  })
  await permission?.ready.promise
  await Promise.resolve()
  return { permission: permission!, dispose }
}

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("permission server persistence", () => {
  test("hydrates auto-accept rules without persisting transient response cache", async () => {
    serverState.seed("permission", {
      value: { autoAccept: { [directoryKey]: true } },
      version: "v1",
      updated_at: 8,
    })

    const result = await mountPermission()
    expect(result.permission.isAutoAcceptingDirectory(directory)).toBe(true)

    result.permission.toggleAutoAcceptDirectory(directory)
    await flushPersistence()

    const record = serverState.get("permission")
    expect((record?.value as { autoAccept?: Record<string, boolean> }).autoAccept?.[directoryKey]).toBe(false)
    expect(JSON.stringify(record?.value)).not.toContain("responded")
    result.dispose()
  })
})
