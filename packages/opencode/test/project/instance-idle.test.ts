import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const registerDisposals = (disposed: string[]) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(async (directory) => void disposed.push(directory))),
    (off) => Effect.sync(off),
  )

describe("InstanceStore idle eviction", () => {
  it.effect("evicts an unleased instance after 15 idle minutes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      yield* store.load({ directory })
      yield* TestClock.adjust(899_000)
      expect(disposed).toEqual([])

      yield* TestClock.adjust("1 second")
      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("keeps with activity leased until the effect completes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      yield* registerDisposals(disposed)

      const active = yield* store
        .with(
          { directory },
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([])

      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(active)
      yield* TestClock.adjust("15 minutes")
      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("starts idling only after the final concurrent lease releases", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* store.acquire({ directory })
      const second = yield* store.acquire({ directory })
      expect(second.context).toBe(first.context)

      yield* first.release
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([])

      yield* second.release
      yield* TestClock.adjust("15 minutes")
      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("reacquiring resets the full idle interval", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* store.acquire({ directory })
      yield* first.release
      yield* TestClock.adjust("10 minutes")

      const second = yield* store.acquire({ directory })
      expect(second.context).toBe(first.context)
      yield* second.release
      yield* TestClock.adjust("10 minutes")
      expect(disposed).toEqual([])

      yield* TestClock.adjust("5 minutes")
      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("explicit dispose and lease release are idempotent", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const current = yield* store.acquire({ directory })
      yield* current.release
      yield* current.release
      yield* store.dispose(current.context)
      yield* store.dispose(current.context)
      yield* TestClock.adjust("30 minutes")

      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("a stale release cannot evict a replacement generation", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* store.acquire({ directory })
      yield* store.dispose(first.context)
      const second = yield* store.acquire({ directory })

      yield* first.release
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([directory])

      yield* second.release
      yield* TestClock.adjust("15 minutes")
      expect(disposed).toEqual([directory, directory])
    }),
  )

  it.effect("interrupted acquisition releases after bootstrap completes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      yield* registerDisposals(disposed)

      const loading = yield* store
        .with(
          { directory },
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(loading)
      yield* TestClock.adjust("15 minutes")

      expect(disposed).toEqual([directory])
    }),
  )
})
