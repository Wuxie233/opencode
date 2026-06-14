import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { installLocalStorage, MemoryStorage, MockServerState } from "./persist-fixture"
import type { PersistServerTransport } from "./persist"

type PersistedType = typeof import("./persist").persisted
type PersistTestingType = typeof import("./persist").PersistTesting

type CountState = {
  count: number
}

const storage = new MemoryStorage()
const server = new MockServerState()

let persisted: PersistedType
let persistTesting: PersistTestingType
let clock = 1_000

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persisted = mod.persisted
  persistTesting = mod.PersistTesting
})

beforeEach(() => {
  storage.reset()
  server.reset()
  installLocalStorage(storage)
  clock = 1_000
})

function transport(input = server): PersistServerTransport {
  return {
    get: (name) => input.get(name),
    put: (name, record) => input.put(name, record),
  }
}

function seedLocal(key: string, value: CountState, updatedAt: number) {
  storage.setItem(key, JSON.stringify(value))
  storage.setItem(
    persistTesting.serverMetadataKey(key),
    JSON.stringify({ value: null, version: "v1", updated_at: updatedAt }),
  )
}

function mount(input?: {
  key?: string
  serverName?: string
  serverTransport?: PersistServerTransport
  legacy?: string[]
}) {
  const key = input?.key ?? "server-hydrate"
  return createRoot((dispose) => {
    const [state, setState, , ready] = persisted(
      {
        key,
        legacy: input?.legacy,
        server: {
          name: input?.serverName ?? "server",
          transport: input?.serverTransport ?? transport(),
          now: () => clock,
          timeoutMs: 20,
        },
      },
      createStore<CountState>({ count: 0 }),
    )

    return { state, setState, ready, dispose }
  })
}

async function waitReady(input: ReturnType<typeof mount>) {
  await input.ready.promise
  await Promise.resolve()
  expect(input.ready()).toBeTrue()
}

async function flushPersistence() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("persist server hydrate", () => {
  test("server hydrate uses server state when local fallback is missing", async () => {
    server.seed("server", { value: { count: 2 }, version: "v1", updated_at: 2 })

    const result = mount()
    await waitReady(result)

    expect(result.state.count).toBe(2)
    expect(storage.getItem("server-hydrate")).toBe('{"count":2}')
    expect(storage.getItem(persistTesting.serverMetadataKey("server-hydrate"))).toBe(
      '{"value":null,"version":"v1","updated_at":2}',
    )
    result.dispose()
  })

  test("server hydrate uses server when it is newer than local fallback", async () => {
    seedLocal("server-hydrate", { count: 1 }, 1)
    server.seed("server", { value: { count: 3 }, version: "v1", updated_at: 2 })

    const result = mount()
    await waitReady(result)

    expect(result.state.count).toBe(3)
    expect(storage.getItem("server-hydrate")).toBe('{"count":3}')
    result.dispose()
  })

  test("server hydrate keeps local fallback when local timestamp is newer", async () => {
    seedLocal("server-hydrate", { count: 5 }, 5)
    server.seed("server", { value: { count: 4 }, version: "v1", updated_at: 4 })

    const result = mount()
    await waitReady(result)

    expect(result.state.count).toBe(5)
    expect(storage.getItem("server-hydrate")).toBe('{"count":5}')
    result.dispose()
  })
})

describe("persist fallback", () => {
  test("plugin unavailable during write keeps local fallback and retries later", async () => {
    const first = mount({ key: "plugin-unavailable-write" })
    await waitReady(first)

    server.unavailable = true
    clock = 40
    first.setState("count", 40)
    await flushPersistence()
    first.dispose()

    expect(storage.getItem("plugin-unavailable-write")).toBe('{"count":40}')
    expect(storage.getItem(persistTesting.serverMetadataKey("plugin-unavailable-write"))).toBe(
      '{"value":null,"version":"v1","updated_at":40}',
    )

    server.unavailable = false
    const second = mount({ key: "plugin-unavailable-write" })
    await waitReady(second)
    await flushPersistence()

    expect(second.state.count).toBe(40)
    expect(server.get("server")).toEqual({ value: { count: 40 }, version: "v1", updated_at: 40 })
    second.dispose()
  })

  test("fallback keeps local state when server is unavailable", async () => {
    seedLocal("fallback", { count: 7 }, 7)
    server.unavailable = true

    const result = mount({ key: "fallback" })
    await waitReady(result)

    expect(result.state.count).toBe(7)
    expect(storage.getItem("fallback")).toBe('{"count":7}')
    result.dispose()
  })

  test("fallback keeps local state when server payload is malformed", async () => {
    seedLocal("fallback", { count: 8 }, 8)

    const result = mount({
      key: "fallback",
      serverTransport: {
        get: () => ({ value: { count: 9 }, version: 1, updated_at: "bad" }),
        put: () => undefined,
      },
    })
    await waitReady(result)

    expect(result.state.count).toBe(8)
    expect(storage.getItem("fallback")).toBe('{"count":8}')
    result.dispose()
  })

  test("fallback ignores malformed server payload when local fallback is empty", async () => {
    const result = mount({
      key: "malformed-empty",
      serverTransport: {
        get: () => ({ value: { count: 9 }, version: "v1", updated_at: Number.NaN }),
        put: () => undefined,
      },
    })
    await waitReady(result)

    expect(result.state.count).toBe(0)
    expect(storage.getItem("malformed-empty")).toBeNull()
    expect(storage.getItem(persistTesting.serverMetadataKey("malformed-empty"))).toBeNull()
    result.dispose()
  })

  test("fallback writes through to server while preserving local fallback", async () => {
    const result = mount({ key: "fallback" })
    await waitReady(result)

    clock = 10
    result.setState("count", 11)
    await flushPersistence()

    expect(storage.getItem("fallback")).toBe('{"count":11}')
    expect(server.get("server")).toEqual({ value: { count: 11 }, version: "v1", updated_at: 10 })
    result.dispose()
  })

  test("fallback local write remains effective when server rejects writes", async () => {
    seedLocal("fallback", { count: 12 }, 12)
    server.unavailable = true

    const result = mount({ key: "fallback" })
    await waitReady(result)

    clock = 13
    result.setState("count", 13)
    await flushPersistence()

    expect(result.state.count).toBe(13)
    expect(storage.getItem("fallback")).toBe('{"count":13}')
    result.dispose()
  })

  test("fallback ready resolves after local hydrate when server fails", async () => {
    seedLocal("fallback", { count: 14 }, 14)
    server.unavailable = true

    const result = mount({ key: "fallback" })
    await waitReady(result)


    expect(result.state.count).toBe(14)
    result.dispose()
  })
})

describe("persist migrate to server", () => {
  test("migrate to server uploads local-only state on first load and keeps local fallback", async () => {
    storage.setItem("migrate-first", JSON.stringify({ count: 21 }))

    const result = mount({ key: "migrate-first" })
    await waitReady(result)
    await flushPersistence()

    expect(result.state.count).toBe(21)
    expect(storage.getItem("migrate-first")).toBe('{"count":21}')
    expect(server.get("server")).toEqual({ value: { count: 21 }, version: "v1", updated_at: 1_000 })
    expect(storage.getItem(persistTesting.serverMetadataKey("migrate-first"))).toBe(
      '{"value":null,"version":"v1","updated_at":1000}',
    )
    result.dispose()
  })

  test("migrate to server is idempotent and does not re-upload unchanged state on second load", async () => {
    storage.setItem("migrate-idempotent", JSON.stringify({ count: 22 }))

    const first = mount({ key: "migrate-idempotent" })
    await waitReady(first)
    await flushPersistence()
    first.dispose()

    const putsAfterFirst = server.calls.put
    expect(putsAfterFirst).toBe(1)

    const second = mount({ key: "migrate-idempotent" })
    await waitReady(second)
    await flushPersistence()

    expect(second.state.count).toBe(22)
    expect(server.calls.put).toBe(putsAfterFirst)
    expect(server.get("server")).toEqual({ value: { count: 22 }, version: "v1", updated_at: 1_000 })
    second.dispose()
  })

  test("migrate to server promotes a legacy key then uploads it to the server", async () => {
    storage.setItem("legacy.count", JSON.stringify({ count: 23 }))

    const result = mount({ key: "migrate-legacy", legacy: ["legacy.count"] })
    await waitReady(result)
    await flushPersistence()

    expect(result.state.count).toBe(23)
    expect(storage.getItem("migrate-legacy")).toBe('{"count":23}')
    expect(storage.getItem("legacy.count")).toBeNull()
    expect(server.get("server")).toEqual({ value: { count: 23 }, version: "v1", updated_at: 1_000 })
    result.dispose()
  })

  test("migrate to server overwrites an older server record with newer local state", async () => {
    seedLocal("migrate-older-server", { count: 25 }, 25)
    server.seed("server", { value: { count: 24 }, version: "v1", updated_at: 24 })

    const result = mount({ key: "migrate-older-server" })
    await waitReady(result)
    await flushPersistence()

    expect(result.state.count).toBe(25)
    expect(server.get("server")).toEqual({ value: { count: 25 }, version: "v1", updated_at: 25 })
    result.dispose()
  })

  test("migrate to server retries on a later load after the server was unavailable", async () => {
    storage.setItem("migrate-retry", JSON.stringify({ count: 26 }))
    server.unavailable = true

    const first = mount({ key: "migrate-retry" })
    await waitReady(first)
    await flushPersistence()
    first.dispose()

    expect(first.state.count).toBe(26)
    expect(storage.getItem("migrate-retry")).toBe('{"count":26}')
    expect(storage.getItem(persistTesting.serverMetadataKey("migrate-retry"))).toBeNull()

    server.unavailable = false
    const second = mount({ key: "migrate-retry" })
    await waitReady(second)
    await flushPersistence()

    expect(second.state.count).toBe(26)
    expect(server.get("server")).toEqual({ value: { count: 26 }, version: "v1", updated_at: 1_000 })
    second.dispose()
  })
})

describe("persist newer server", () => {
  test("stale local write restores the authoritative server fallback", async () => {
    seedLocal("stale-write", { count: 30 }, 30)
    server.seed("server", { value: { count: 50 }, version: "v1", updated_at: 50 })

    const result = mount({ key: "stale-write" })
    await waitReady(result)

    clock = 40
    result.setState("count", 40)
    await flushPersistence()

    expect(server.get("server")).toEqual({ value: { count: 50 }, version: "v1", updated_at: 50 })
    expect(storage.getItem("stale-write")).toBe('{"count":50}')
    expect(storage.getItem(persistTesting.serverMetadataKey("stale-write"))).toBe(
      '{"value":null,"version":"v1","updated_at":50}',
    )
    result.dispose()
  })

  test("equal timestamp local write restores the authoritative server fallback", async () => {
    seedLocal("equal-write", { count: 60 }, 60)
    server.seed("server", { value: { count: 61 }, version: "v1", updated_at: 60 })

    const result = mount({ key: "equal-write" })
    await waitReady(result)

    clock = 60
    result.setState("count", 62)
    await flushPersistence()

    expect(server.get("server")).toEqual({ value: { count: 61 }, version: "v1", updated_at: 60 })
    expect(storage.getItem("equal-write")).toBe('{"count":61}')
    result.dispose()
  })

  test("newer server state wins over older local data and hydrates the store", async () => {
    seedLocal("newer-server-local", { count: 30 }, 30)
    server.seed("server", { value: { count: 31 }, version: "v1", updated_at: 31 })

    const result = mount({ key: "newer-server-local" })
    await waitReady(result)
    await flushPersistence()

    expect(result.state.count).toBe(31)
    expect(storage.getItem("newer-server-local")).toBe('{"count":31}')
    expect(server.get("server")).toEqual({ value: { count: 31 }, version: "v1", updated_at: 31 })
    result.dispose()
  })

  test("newer server state is preserved against an older local-only first-load upload", async () => {
    storage.setItem("newer-server-firstload", JSON.stringify({ count: 32 }))
    server.seed("server", { value: { count: 33 }, version: "v1", updated_at: 33 })

    const result = mount({ key: "newer-server-firstload" })
    await waitReady(result)
    await flushPersistence()

    expect(result.state.count).toBe(33)
    expect(server.get("server")).toEqual({ value: { count: 33 }, version: "v1", updated_at: 33 })
    result.dispose()
  })
})
