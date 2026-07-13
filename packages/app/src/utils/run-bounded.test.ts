import { describe, expect, test } from "bun:test"
import { runBounded } from "./run-bounded"

describe("runBounded", () => {
  test("runs every item with bounded concurrency", async () => {
    const items = Array.from({ length: 12 }, (_, index) => index)
    const completed: number[] = []
    let active = 0
    let peak = 0

    await runBounded(
      items,
      async (item) => {
        active++
        peak = Math.max(peak, active)
        await Bun.sleep(1)
        completed.push(item)
        active--
      },
      { concurrency: 3 },
    )

    expect(peak).toBe(3)
    expect(completed.toSorted((a, b) => a - b)).toEqual(items)
  })

  test("stops dispatching queued items after cancellation", async () => {
    const controller = new AbortController()
    const started: number[] = []
    const completed: number[] = []
    const release = Promise.withResolvers<void>()
    const running = runBounded(
      [1, 2, 3],
      async (item) => {
        started.push(item)
        await release.promise
        completed.push(item)
      },
      { concurrency: 2, signal: controller.signal },
    )

    await Bun.sleep(0)
    controller.abort()
    release.resolve()
    await running

    expect(started.toSorted()).toEqual([1, 2])
    expect(completed.toSorted()).toEqual([1, 2])
  })
})
