import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { installLocalStorage, MemoryStorage, mockServerStateFetch, MockServerState } from "../utils/persist-fixture"
import { Persist, persisted } from "../utils/persist"
import { webStateServer } from "../utils/web-state"
import { buildNotificationIndex, pruneNotifications, type Notification } from "./notification"

type NotificationStore = { list: Notification[] }

const storage = new MemoryStorage()
const serverState = new MockServerState()
let fetcher = mockServerStateFetch(serverState)
type TestGlobal = typeof globalThis & { __OPENCODE_TEST_FETCHER?: typeof fetch }
const testGlobal = globalThis as TestGlobal
testGlobal.__OPENCODE_TEST_FETCHER = fetcher

mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", fetch: testGlobal.__OPENCODE_TEST_FETCHER }),
}))

beforeAll(() => {
  installLocalStorage(storage)
})

beforeEach(() => {
  storage.reset()
  serverState.reset()
  fetcher = mockServerStateFetch(serverState)
  testGlobal.__OPENCODE_TEST_FETCHER = fetcher
  installLocalStorage(storage)
})

function mountNotificationStore() {
  let store: NotificationStore | undefined
  let ready: ReturnType<typeof persisted>[3] | undefined
  let dispose = () => {}
  createRoot((done) => {
    dispose = done
    const result = persisted(
      {
        ...Persist.global("notification", ["notification.v1"]),
        server: webStateServer("notification", {
          server: () => ({ url: "http://state.test" }),
          fetch: fetcher,
        }),
      },
      createStore<NotificationStore>({ list: [] }),
    )
    store = result[0]
    ready = result[3]
  })
  return { store: store!, ready: ready!, dispose }
}

describe("notification server persistence", () => {
  test("prunes server-hydrated notification source data and rebuilds indexes", async () => {
    const now = Date.now()
    const old: Notification = {
      type: "turn-complete",
      directory: "/repo",
      session: "old",
      viewed: false,
      time: now - 31 * 24 * 60 * 60 * 1000,
    }
    const recent = Array.from({ length: 501 }, (_, index): Notification => ({
      type: "turn-complete",
      directory: "/repo",
      session: `s${index}`,
      viewed: false,
      time: now - 1000 + index,
    }))
    serverState.seed("notification", { value: { list: [old, ...recent] }, version: "v1", updated_at: 10 })

    const result = mountNotificationStore()
    await result.ready.promise

    const index = buildNotificationIndex(pruneNotifications(result.store.list))

    expect(index.session.unseenCount.old).toBeUndefined()
    expect(index.session.unseenCount.s0).toBeUndefined()
    expect(index.session.unseenCount.s1).toBe(1)
    expect(index.session.unseenCount.s500).toBe(1)
    expect(index.project.unseenCount["/repo"]).toBe(500)
    result.dispose()
  })
})
