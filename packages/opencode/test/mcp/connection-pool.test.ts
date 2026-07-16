import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ConnectionPool } from "../../src/mcp/connection-pool"
import { it } from "../lib/effect"

const lease = Effect.fnUntraced(function* (pool: ConnectionPool.TestPool<string>, key: string) {
  const scope = yield* Scope.make()
  const value = yield* pool.get(key).pipe(Scope.provide(scope))
  return { value, release: Scope.close(scope, Exit.void) }
})

describe("MCP connection pool", () => {
  it.effect("keys connections by directory and a stable non-secret config fingerprint", () =>
    Effect.sync(() => {
      const config = {
        type: "remote" as const,
        url: "https://example.com/mcp",
        oauth: false as const,
        headers: { Authorization: "Bearer top-secret", "X-Workspace": "alpha" },
      }
      const reordered = {
        headers: { "X-Workspace": "alpha", Authorization: "Bearer top-secret" },
        oauth: false as const,
        url: "https://example.com/mcp",
        type: "remote" as const,
      }
      const original = ConnectionPool.input("/workspace/one", "server", config)
      const same = ConnectionPool.input("/workspace/one", "server", reordered)
      const otherDirectory = ConnectionPool.input("/workspace/two", "server", config)
      const otherConfig = ConnectionPool.input("/workspace/one", "server", {
        ...config,
        headers: { ...config.headers, "X-Workspace": "beta" },
      })

      expect(original.key.fingerprint).toBe(same.key.fingerprint)
      expect(original.key.directory).not.toBe(otherDirectory.key.directory)
      expect(original.key.fingerprint).not.toBe(otherConfig.key.fingerprint)
      expect(JSON.stringify(original.key)).not.toContain("top-secret")
    }),
  )

  it.effect("keeps a released connection for two hours and closes it at the lease boundary", () =>
    Effect.gen(function* () {
      const acquired: string[] = []
      const closed: string[] = []
      const pool = yield* ConnectionPool.make({
        idleTimeToLive: "2 hours",
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired.push(key)
              return key
            }),
            (value) => Effect.sync(() => void closed.push(value)),
          ),
      })

      const connection = yield* lease(pool, "alpha")
      expect(connection.value).toBe("alpha")
      expect(acquired).toEqual(["alpha"])
      yield* connection.release
      yield* TestClock.adjust(7_199_000)
      expect(closed).toEqual([])
      yield* TestClock.adjust("1 second")
      expect(closed).toEqual(["alpha"])
    }),
  )

  it.effect("resets the full idle lease when a connection is borrowed again", () =>
    Effect.gen(function* () {
      const closed: string[] = []
      const pool = yield* ConnectionPool.make({
        idleTimeToLive: "2 hours",
        lookup: (key: string) =>
          Effect.acquireRelease(Effect.succeed(key), (value) => Effect.sync(() => void closed.push(value))),
      })

      yield* (yield* lease(pool, "alpha")).release
      yield* TestClock.adjust("1 hour")
      yield* (yield* lease(pool, "alpha")).release
      yield* TestClock.adjust(7_199_000)
      expect(closed).toEqual([])
      yield* TestClock.adjust("1 second")
      expect(closed).toEqual(["alpha"])
    }),
  )

  it.effect("does not close an active operation and starts its idle lease after completion", () =>
    Effect.gen(function* () {
      const closed: string[] = []
      const complete = yield* Deferred.make<void>()
      const pool = yield* ConnectionPool.make({
        idleTimeToLive: "2 hours",
        lookup: (key: string) =>
          Effect.acquireRelease(Effect.succeed(key), (value) => Effect.sync(() => void closed.push(value))),
      })
      const scope = yield* Scope.make()
      const running = yield* pool
        .use("alpha", () => Deferred.await(complete))
        .pipe(Scope.provide(scope), Effect.forkScoped)

      yield* TestClock.adjust("3 hours")
      expect(closed).toEqual([])
      yield* Deferred.succeed(complete, undefined)
      yield* Fiber.join(running)
      yield* Scope.close(scope, Exit.void)
      yield* TestClock.adjust(7_199_000)
      expect(closed).toEqual([])
      yield* TestClock.adjust("1 second")
      expect(closed).toEqual(["alpha"])
    }),
  )

  it.effect("invalidates reuse without interrupting an active borrower", () =>
    Effect.gen(function* () {
      const closed: string[] = []
      const pool = yield* ConnectionPool.make({
        idleTimeToLive: "2 hours",
        lookup: (key: string) =>
          Effect.acquireRelease(Effect.succeed(key), (value) => Effect.sync(() => void closed.push(value))),
      })
      const active = yield* lease(pool, "alpha")
      yield* pool.invalidate("alpha")
      expect(closed).toEqual([])
      yield* active.release
      expect(closed).toEqual(["alpha"])
    }),
  )

  it.effect("keeps a replacement generation alive after an invalidated borrower releases", () =>
    Effect.gen(function* () {
      const acquired: string[] = []
      const closed: string[] = []
      const pool = yield* ConnectionPool.make({
        idleTimeToLive: "2 hours",
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const value = `${key}:${acquired.length + 1}`
              acquired.push(value)
              return value
            }),
            (value) => Effect.sync(() => void closed.push(value)),
          ),
      })

      const original = yield* lease(pool, "alpha")
      yield* pool.invalidate("alpha")
      const replacement = yield* lease(pool, "alpha")

      yield* original.release
      expect(replacement.value).toBe("alpha:2")

      yield* replacement.release
      yield* TestClock.adjust("2 hours")
      expect(closed).toEqual(["alpha:1", "alpha:2"])

      const next = yield* lease(pool, "alpha")
      expect(next.value).toBe("alpha:3")
      yield* next.release
    }),
  )

  it.effect("keeps an active replacement through the invalidated generation's full idle window", () =>
    Effect.gen(function* () {
      const acquired: string[] = []
      const closed: string[] = []
      const pool = yield* ConnectionPool.make({
        idleTimeToLive: "2 hours",
        lookup: (key: string) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const value = `${key}:${acquired.length + 1}`
              acquired.push(value)
              return value
            }),
            (value) => Effect.sync(() => void closed.push(value)),
          ),
      })

      const original = yield* lease(pool, "alpha")
      yield* pool.invalidate("alpha")
      const replacement = yield* lease(pool, "alpha")

      yield* original.release
      yield* TestClock.adjust("2 hours")

      expect(replacement.value).toBe("alpha:2")
      expect(closed).toEqual(["alpha:1"])

      yield* replacement.release
      yield* TestClock.adjust("2 hours")
      expect(closed).toEqual(["alpha:1", "alpha:2"])
    }),
  )
})
