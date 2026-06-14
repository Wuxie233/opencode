import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"
import { defaultWebStateServer } from "../utils/web-state"
import type { Platform } from "./platform"

type PersistModule = typeof import("../utils/persist")
type LanguageStore = { locale: string }

const storage = new MemoryStorage()
const serverState = new MockServerState()
let fetcher = mockServerStateFetch(serverState)
type TestGlobal = typeof globalThis & { __OPENCODE_TEST_FETCHER?: typeof fetch }
const testGlobal = globalThis as TestGlobal
testGlobal.__OPENCODE_TEST_FETCHER = fetcher

type ServerKey = NonNullable<Awaited<ReturnType<NonNullable<Platform["getDefaultServer"]>>>>

const platform: Pick<Platform, "fetch" | "getDefaultServer"> = {
  getDefaultServer: async () => "http://state.test" as ServerKey,
  get fetch() {
    return testGlobal.__OPENCODE_TEST_FETCHER
  },
}

mock.module("@/context/platform", () => ({
  usePlatform: () => platform,
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

function mountLanguageStore() {
  let store: LanguageStore | undefined
  let ready: ReturnType<PersistModule["persisted"]>[3] | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    const result = persisted(
      {
        ...Persist.global("language", ["language.v1"]),
        server: defaultWebStateServer("language", platform),
      },
      createStore<LanguageStore>({ locale: "en" }),
    )
    store = result[0]
    ready = result[3]
  })
  return { store: store!, ready: ready!, dispose }
}

describe("language server persistence", () => {
  test("hydrates language source data from the default server target", async () => {
    serverState.seed("language", { value: { locale: "zh" }, version: "v1", updated_at: 3 })

    const result = mountLanguageStore()
    await result.ready.promise

    expect(result.store.locale).toBe("zh")
    expect(storage.getItem("opencode.global.dat:language")).toBe('{"locale":"zh"}')
    result.dispose()
  })
})
