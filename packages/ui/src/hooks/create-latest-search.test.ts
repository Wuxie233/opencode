import { describe, expect, test } from "bun:test"
import { createLatestSearch } from "./create-latest-search"

describe("createLatestSearch", () => {
  test("aborts the previous search before starting the next", async () => {
    const signals: AbortSignal[] = []
    const pending = Promise.withResolvers<string>()
    const search = createLatestSearch((_, signal) => {
      signals.push(signal)
      return pending.promise
    })
    const first = search.run("one")
    const second = search.run("two")

    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    pending.resolve("done")
    expect(await first).toBe("done")
    expect(await second).toBe("done")
  })

  test("aborts the active search when stopped", () => {
    let signal: AbortSignal | undefined
    const search = createLatestSearch((_, current) => {
      signal = current
      return new Promise(() => {})
    })

    void search.run("query")
    search.stop()

    expect(signal?.aborted).toBe(true)
  })

  test("keeps the restarted search active when the previous search settles", async () => {
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const signals: AbortSignal[] = []
    let calls = 0
    const search = createLatestSearch((_, signal) => {
      signals.push(signal)
      return ++calls === 1 ? first.promise : second.promise
    })

    const stale = search.run("one")
    void search.run("two")
    first.resolve("stale")
    await stale
    search.stop()

    expect(signals[1]?.aborted).toBe(true)
    second.resolve("current")
  })
})
