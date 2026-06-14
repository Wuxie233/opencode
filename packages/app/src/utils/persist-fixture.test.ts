import { describe, expect, test } from "bun:test"
import { installLocalStorage, MemoryStorage, MockServerState } from "./persist-fixture"

describe("persist-fixture MemoryStorage", () => {
  test("installs an isolated localStorage and records calls", () => {
    const storage = installLocalStorage()
    localStorage.setItem("opencode.safe", '{"value":1}')
    expect(localStorage.getItem("opencode.safe")).toBe('{"value":1}')
    expect(storage.calls.set).toBe(1)
    expect(storage.calls.get).toBe(1)
  })

  test("throws QuotaExceededError for quota-prefixed keys", () => {
    const storage = new MemoryStorage()
    expect(() => storage.setItem("opencode.quota.scope", "x")).toThrow()
  })

  test("instances do not share state", () => {
    const a = new MemoryStorage()
    const b = new MemoryStorage()
    a.setItem("k", "1")
    expect(b.getItem("k")).toBeNull()
    expect(a.length).toBe(1)
    expect(b.length).toBe(0)
  })
})

describe("persist-fixture MockServerState", () => {
  test("round-trips records and lists keys", () => {
    const server = new MockServerState()
    server.put("layout", { value: { tab: 1 }, version: "v1", updated_at: 100 })
    expect(server.get("layout")).toEqual({ value: { tab: 1 }, version: "v1", updated_at: 100 })
    expect(server.list()).toEqual(["layout"])
  })

  test("applies last-write-wins by updated_at", () => {
    const server = new MockServerState()
    server.put("settings", { value: "old", version: "v1", updated_at: 200 })
    server.put("settings", { value: "stale", version: "v1", updated_at: 100 })
    expect(server.get("settings")?.value).toBe("old")
    server.put("settings", { value: "new", version: "v1", updated_at: 300 })
    expect(server.get("settings")?.value).toBe("new")
  })

  test("unavailable flag simulates plugin failure", () => {
    const server = new MockServerState()
    server.unavailable = true
    expect(() => server.get("x")).toThrow()
  })

  test("instances are isolated", () => {
    const a = new MockServerState()
    const b = new MockServerState()
    a.put("k", { value: 1, version: "v1", updated_at: 1 })
    expect(b.get("k")).toBeUndefined()
  })
})
