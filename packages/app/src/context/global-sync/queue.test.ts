import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })

  test("runs two directories concurrently", async () => {
    const started: string[] = []
    const gates = new Map<string, PromiseWithResolvers<void>>()
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        started.push(directory)
        const gate = Promise.withResolvers<void>()
        gates.set(directory, gate)
        return gate.promise
      },
    })

    queue.push("/one")
    queue.push("/two")
    queue.push("/three")
    await tick()

    expect(started).toEqual(["/one", "/two"])
    gates.get("/one")?.resolve()
    gates.get("/two")?.resolve()
    await tick()
    expect(started).toEqual(["/one", "/two", "/three"])
    gates.get("/three")?.resolve()
    queue.dispose()
  })

  test("coalesces recovery into full refresh and leaves one trailing run", async () => {
    const calls: { directory: string; full: boolean }[] = []
    const gates: PromiseWithResolvers<void>[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: (directory, full) => {
        calls.push({ directory, full })
        const gate = Promise.withResolvers<void>()
        gates.push(gate)
        return gate.promise
      },
    })

    queue.push("/project")
    await tick()
    expect(calls).toEqual([{ directory: "/project", full: true }])

    queue.recover("/project")
    queue.push("/project")
    queue.recover("/project")
    gates[0]?.resolve()
    await tick()
    expect(calls).toEqual([
      { directory: "/project", full: true },
      { directory: "/project", full: true },
    ])
    gates[1]?.resolve()
    queue.dispose()
  })

  test("merges refreshes while waiting for an existing bootstrap", async () => {
    const existing = Promise.withResolvers<void>()
    const calls: { directory: string; full: boolean }[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      wait: () => existing.promise,
      bootstrapInstance: async (directory, full) => {
        calls.push({ directory, full })
      },
    })

    queue.recover("/project")
    await tick()
    queue.push("/project")
    queue.recover("/project")
    existing.resolve()
    await tick()

    expect(calls).toEqual([{ directory: "/project", full: true }])
    queue.dispose()
  })
})
