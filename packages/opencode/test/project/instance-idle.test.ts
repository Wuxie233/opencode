import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { registerDisposer } from "../../src/effect/instance-registry"
import { ProcessPressure } from "../../src/observability/process-pressure"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const testBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, testBootstrap],
  ]),
)

const registerDisposals = (disposed: string[]) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(async (directory) => void disposed.push(directory))),
    (off) => Effect.sync(off),
  )

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const lease = Effect.fnUntraced(function* (store: InstanceStore.Interface, directory: string) {
  const scope = yield* Scope.make()
  const ctx = yield* store.load({ directory }).pipe(Scope.provide(scope))
  return { ctx, release: Scope.close(scope, Exit.void) }
})

describe("InstanceStore idle eviction", () => {
  it.effect("evicts once after a released instance has been idle for 15 minutes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const current = yield* lease(store, directory)
      yield* current.release
      yield* TestClock.adjust(899_000)

      expect(disposed).toEqual([])
      expect(ProcessPressure.snapshot().liveInstances).toBe(1)

      yield* TestClock.adjust("1 second")

      expect(disposed).toEqual([directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(0)
    }),
  )

  it.effect("keeps an actively leased instance beyond the idle interval", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const current = yield* lease(store, directory)
      yield* TestClock.adjust("30 minutes")

      expect(disposed).toEqual([])
      expect(ProcessPressure.snapshot().liveInstances).toBe(1)
      yield* current.release
    }),
  )

  it.effect("starts the idle interval only after the final lease releases", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* lease(store, directory)
      const second = yield* lease(store, directory)
      expect(second.ctx).toBe(first.ctx)

      yield* first.release
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([])

      yield* second.release
      yield* TestClock.adjust(899_000)
      expect(disposed).toEqual([])

      yield* TestClock.adjust("1 second")
      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("reacquire resets the full interval and invalidates the stale timer", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* lease(store, directory)
      yield* first.release
      yield* TestClock.adjust("10 minutes")

      const second = yield* lease(store, directory)
      expect(second.ctx).toBe(first.ctx)
      yield* second.release
      yield* TestClock.adjust("5 minutes")
      expect(disposed).toEqual([])

      yield* TestClock.adjust(599_000)
      expect(disposed).toEqual([])

      yield* TestClock.adjust("1 second")
      expect(disposed).toEqual([directory])
    }),
  )

  it.effect("explicit dispose cancels pending eviction without double disposal", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const current = yield* lease(store, directory)
      yield* current.release
      yield* TestClock.adjust("5 minutes")
      yield* store.dispose(current.ctx)
      yield* TestClock.adjust("30 minutes")

      expect(disposed).toEqual([directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(0)
    }),
  )

  it.effect("stale dispose after idle eviction is a no-op", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const current = yield* lease(store, directory)
      yield* current.release
      yield* TestClock.adjust("15 minutes")
      yield* store.dispose(current.ctx)

      expect(disposed).toEqual([directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(0)
    }),
  )

  it.effect("stale release after explicit dispose cannot affect the replacement generation", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* lease(store, directory)
      yield* store.dispose(first.ctx)
      const second = yield* lease(store, directory)

      yield* first.release
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(1)

      yield* second.release
      yield* TestClock.adjust(899_000)
      expect(disposed).toEqual([directory])

      yield* TestClock.adjust("1 second")
      expect(disposed).toEqual([directory, directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(0)
    }),
  )

  it.effect("stale release after reload cannot affect the replacement generation", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* lease(store, directory)
      const reloaded = yield* store.reload({ directory })
      const second = yield* lease(store, directory)
      expect(second.ctx).toBe(reloaded)

      yield* first.release
      yield* TestClock.adjust("30 minutes")
      expect(disposed).toEqual([directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(1)

      yield* second.release
      yield* TestClock.adjust(899_000)
      expect(disposed).toEqual([directory])

      yield* TestClock.adjust("1 second")
      expect(disposed).toEqual([directory, directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(0)
    }),
  )

  it.effect("evicts two directories independently", () =>
    Effect.gen(function* () {
      const firstDirectory = yield* tmpdirScoped({ git: true })
      const secondDirectory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      const first = yield* lease(store, firstDirectory)
      yield* first.release
      yield* TestClock.adjust("5 minutes")

      const second = yield* lease(store, secondDirectory)
      yield* second.release
      yield* TestClock.adjust("10 minutes")
      expect(disposed).toEqual([firstDirectory])

      yield* TestClock.adjust("5 minutes")
      expect(disposed).toEqual([firstDirectory, secondDirectory])
    }),
  )

  it.effect("interrupted lease acquisition does not leak after bootstrap completes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const disposed: string[] = []
      yield* registerDisposals(disposed)

      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finish)
        }),
      )

      const loading = yield* store.load({ directory }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(loading)
      yield* Deferred.succeed(finish, undefined)

      const retry = yield* lease(store, directory)
      yield* retry.release
      yield* TestClock.adjust("15 minutes")

      expect(disposed).toEqual([directory])
      expect(ProcessPressure.snapshot().liveInstances).toBe(0)
    }),
  )
})
