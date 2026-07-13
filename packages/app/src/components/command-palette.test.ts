import { describe, expect, test } from "bun:test"
import { createSessionEntries } from "./command-palette-session-load"

describe("createSessionEntries", () => {
  test("loads workspaces with bounded concurrency and preserves their order", async () => {
    const directories = Array.from({ length: 9 }, (_, index) => `/project-${index}`)
    let active = 0
    let peak = 0
    const sessions = createSessionEntries({
      workspaces: () => directories,
      label: (directory) => directory,
      load: async (directory) => {
        active++
        peak = Math.max(peak, active)
        await Bun.sleep(1)
        active--
        return { data: [{ id: `session-${directory}`, title: directory }] }
      },
      untitled: () => "Untitled",
      category: () => "Sessions",
    })

    const result = await sessions("project")

    expect(peak).toBe(4)
    expect(result.map((entry) => entry.directory)).toEqual(directories)
  })

  test("aborts active workspace loads and stops queued loads when search is cleared", async () => {
    const started: string[] = []
    const aborted: string[] = []
    const sessions = createSessionEntries({
      workspaces: () => ["/one", "/two", "/three", "/four", "/five"],
      label: (directory) => directory,
      load: (directory, signal) => {
        started.push(directory)
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(directory)
            reject(signal.reason)
          })
        })
      },
      untitled: () => "Untitled",
      category: () => "Sessions",
    })

    const loading = Promise.resolve(sessions("project"))
    await Bun.sleep(0)
    expect(sessions(" ")).toEqual([])
    expect(await loading).toEqual([])

    expect(started).toHaveLength(4)
    expect(aborted).toEqual(started)
  })

  test("keeps a restarted search inflight when the cancelled search settles", async () => {
    const first = Promise.withResolvers<{ data: [] }>()
    const second = Promise.withResolvers<{ data: [] }>()
    let calls = 0
    const sessions = createSessionEntries({
      workspaces: () => ["/project"],
      label: (directory) => directory,
      load: () => (++calls === 1 ? first.promise : second.promise),
      untitled: () => "Untitled",
      category: () => "Sessions",
    })

    const cancelled = Promise.resolve(sessions("first"))
    expect(sessions(" ")).toEqual([])
    const restarted = Promise.resolve(sessions("second"))
    first.resolve({ data: [] })
    await cancelled

    expect(sessions("second")).toBe(restarted)
    second.resolve({ data: [] })
    await restarted
    expect(calls).toBe(2)
  })
})
