import { describe, expect, test } from "bun:test"
import { createScrollScheduler } from "./scroll-scheduler"

function frames() {
  let next = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    schedule(callback: FrameRequestCallback) {
      next += 1
      callbacks.set(next, callback)
      return next
    },
    cancel(id: number) {
      callbacks.delete(id)
    },
    flush() {
      const queued = Array.from(callbacks.values())
      callbacks.clear()
      queued.forEach((callback) => callback(0))
    },
    size: () => callbacks.size,
  }
}

describe("createScrollScheduler", () => {
  test("coalesces a burst into two measurements", () => {
    const raf = frames()
    let measured = 0
    const scheduler = createScrollScheduler({
      measure: () => measured++,
      schedule: raf.schedule,
      cancel: raf.cancel,
    })

    for (const _ of Array.from({ length: 50 })) scheduler.queue()

    expect(raf.size()).toBe(1)
    raf.flush()
    expect(measured).toBe(1)
    expect(raf.size()).toBe(1)
    raf.flush()
    expect(measured).toBe(2)
    expect(raf.size()).toBe(0)
  })

  test("new work during the second frame keeps two stable measurements", () => {
    const raf = frames()
    let measured = 0
    const scheduler = createScrollScheduler({
      measure: () => measured++,
      schedule: raf.schedule,
      cancel: raf.cancel,
    })

    scheduler.queue()
    raf.flush()
    scheduler.queue()
    raf.flush()
    raf.flush()

    expect(measured).toBe(3)
    expect(raf.size()).toBe(0)
  })

  test("stop cancels queued measurements", () => {
    const raf = frames()
    let measured = 0
    const scheduler = createScrollScheduler({
      measure: () => measured++,
      schedule: raf.schedule,
      cancel: raf.cancel,
    })

    scheduler.queue()
    scheduler.stop()
    raf.flush()

    expect(measured).toBe(0)
    expect(raf.size()).toBe(0)
  })
})
