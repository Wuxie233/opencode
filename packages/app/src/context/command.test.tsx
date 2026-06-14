import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"
import { webStateServer } from "../utils/web-state"

type PersistModule = typeof import("../utils/persist")
type CommandCatalog = Record<string, { title: string; keybind?: string }>

const storage = new MemoryStorage()
const serverState = new MockServerState()
let fetcher = mockServerStateFetch(serverState)
type TestGlobal = typeof globalThis & { __OPENCODE_TEST_FETCHER?: typeof fetch }
const testGlobal = globalThis as TestGlobal
testGlobal.__OPENCODE_TEST_FETCHER = fetcher

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
}))

let persisted: PersistModule["persisted"]
let Persist: PersistModule["Persist"]

beforeAll(async () => {
  const mod = await import("../utils/persist")
  persisted = mod.persisted
  Persist = mod.Persist
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  installLocalStorage(storage)
})

function mountCatalog() {
  let catalog: CommandCatalog | undefined
  let setCatalog: ((value: CommandCatalog) => void) | undefined
  let ready: ReturnType<PersistModule["persisted"]>[3] | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    const result = persisted(
      {
        ...Persist.global("command.catalog.v1"),
        server: webStateServer("command.catalog.v1", {
          server: () => ({ url: "http://state.test" }),
          fetch: fetcher,
        }),
      },
      createStore<CommandCatalog>({}),
    )
    catalog = result[0]
    setCatalog = result[1]
    ready = result[3]
  })
  return { catalog: catalog!, setCatalog: setCatalog!, ready: ready!, dispose }
}

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("command catalog server persistence", () => {
  test("hydrates and writes command.catalog.v1 source data through server state", async () => {
    serverState.seed("command.catalog.v1", {
      value: { "test.run": { title: "Run Test", keybind: "ctrl+t" } },
      version: "v1",
      updated_at: 4,
    })

    const result = mountCatalog()
    await result.ready.promise

    expect(result.catalog["test.run"]?.title).toBe("Run Test")

    result.setCatalog({ "test.stop": { title: "Stop Test" } })
    await flushPersistence()

    const record = serverState.get("command.catalog.v1")
    expect((record?.value as CommandCatalog)["test.stop"]?.title).toBe("Stop Test")
    result.dispose()
  })
})
