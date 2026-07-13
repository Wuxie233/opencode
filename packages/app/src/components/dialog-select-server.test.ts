import { describe, expect, test, vi } from "bun:test"
import { createServerPreview } from "./dialog-select-server-preview"

describe("createServerPreview", () => {
  test("checks only the latest value after the debounce window", async () => {
    vi.useFakeTimers()
    try {
      const checked: string[] = []
      const statuses: boolean[] = []
      const preview = createServerPreview(async (http) => {
        checked.push(http.url)
        return { healthy: true }
      })

      preview.run({ url: "http://one.test" }, (value) => statuses.push(value))
      preview.run({ url: "http://two.test" }, (value) => statuses.push(value))

      vi.advanceTimersByTime(299)
      expect(checked).toEqual([])

      vi.advanceTimersByTime(1)
      await Promise.resolve()

      expect(checked).toEqual(["http://two.test"])
      expect(statuses).toEqual([true])
      preview.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("ignores a stale response that finishes after a newer check", async () => {
    vi.useFakeTimers()
    try {
      const pending: Array<(value: { healthy: boolean }) => void> = []
      const statuses: boolean[] = []
      const signals: AbortSignal[] = []
      const preview = createServerPreview(
        (_http, signal) => {
          signals.push(signal)
          return new Promise((resolve) => pending.push(resolve))
        },
        10,
      )

      preview.run({ url: "http://one.test" }, (value) => statuses.push(value))
      vi.advanceTimersByTime(10)
      preview.run({ url: "http://two.test" }, (value) => statuses.push(value))
      vi.advanceTimersByTime(10)

      expect(signals[0]?.aborted).toBeTrue()
      expect(signals[1]?.aborted).toBeFalse()

      pending[1]?.({ healthy: true })
      await Promise.resolve()
      pending[0]?.({ healthy: false })
      await Promise.resolve()

      expect(statuses).toEqual([true])
      preview.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("stop cancels queued checks and invalidates in-flight responses", async () => {
    vi.useFakeTimers()
    try {
      const pending: Array<(value: { healthy: boolean }) => void> = []
      const statuses: boolean[] = []
      const signals: AbortSignal[] = []
      const preview = createServerPreview(
        (_http, signal) => {
          signals.push(signal)
          return new Promise((resolve) => pending.push(resolve))
        },
        10,
      )

      preview.run({ url: "http://queued.test" }, (value) => statuses.push(value))
      preview.stop()
      vi.advanceTimersByTime(10)
      expect(pending).toHaveLength(0)

      preview.run({ url: "http://running.test" }, (value) => statuses.push(value))
      vi.advanceTimersByTime(10)
      preview.stop()
      expect(signals[0]?.aborted).toBeTrue()
      pending[0]?.({ healthy: true })
      await Promise.resolve()

      expect(statuses).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
