import { describe, expect, test } from "bun:test"
import { loadHomeSessions } from "./home-session-load"

describe("loadHomeSessions", () => {
  test("loads every directory with bounded concurrency", async () => {
    const directories = Array.from({ length: 12 }, (_, index) => `/project-${index}`)
    const loaded: string[] = []
    let active = 0
    let peak = 0

    await loadHomeSessions(
      directories,
      async (directory) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        loaded.push(directory)
        active--
      },
      { concurrency: 3 },
    )

    expect(peak).toBe(3)
    expect(loaded.toSorted()).toEqual(directories.toSorted())
  })

  test("uses six workers by default", async () => {
    const directories = Array.from({ length: 12 }, (_, index) => `/project-${index}`)
    let active = 0
    let peak = 0

    await loadHomeSessions(directories, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
    })

    expect(peak).toBe(6)
  })

  test("does not invoke the loader for an empty directory list", async () => {
    let calls = 0
    await loadHomeSessions([], async () => {
      calls++
    })
    expect(calls).toBe(0)
  })

  test("stops dispatching queued directories after cancellation", async () => {
    const controller = new AbortController()
    const started: string[] = []
    const release = Promise.withResolvers<void>()
    const loading = loadHomeSessions(
      ["/one", "/two", "/three"],
      async (directory) => {
        started.push(directory)
        if (directory === "/one") await release.promise
      },
      { concurrency: 1, signal: controller.signal },
    )

    await Bun.sleep(0)
    controller.abort()
    release.resolve()
    await loading

    expect(started).toEqual(["/one"])
  })

  test("lets already dispatched loads finish after cancellation", async () => {
    const controller = new AbortController()
    const completed: string[] = []
    const release = Promise.withResolvers<void>()
    const loading = loadHomeSessions(
      ["/one", "/two", "/three"],
      async (directory) => {
        await release.promise
        completed.push(directory)
      },
      { concurrency: 2, signal: controller.signal },
    )

    await Bun.sleep(0)
    controller.abort()
    release.resolve()
    await loading

    expect(completed.toSorted()).toEqual(["/one", "/two"])
  })
})
