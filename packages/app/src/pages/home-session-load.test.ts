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
      3,
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
})
