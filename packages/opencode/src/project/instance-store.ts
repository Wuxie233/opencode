import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Lease {
  readonly context: InstanceContext
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly acquire: (input: LoadInput) => Effect.Effect<Lease>
  readonly with: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
  readonly closed: Deferred.Deferred<void>
  leases: number
  idleCancel: Deferred.Deferred<void> | undefined
  closing: boolean
}

const idleTimeToLive = Duration.minutes(15)

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()

    const makeEntry = (): Entry => ({
      deferred: Deferred.makeUnsafe<InstanceContext>(),
      closed: Deferred.makeUnsafe<void>(),
      leases: 0,
      idleCancel: undefined,
      closing: false,
    })

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const claimClosing = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry || entry.closing) return false
        entry.closing = true
        if (entry.idleCancel) Deferred.doneUnsafe(entry.idleCancel, Effect.void)
        entry.idleCancel = undefined
        return true
      })

    const claimIdleClosing = (directory: string, entry: Entry, cancel: Deferred.Deferred<void>) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry || entry.closing || entry.leases !== 0 || entry.idleCancel !== cancel)
          return false
        entry.closing = true
        entry.idleCancel = undefined
        return true
      })

    const finishClosing = (directory: string, entry: Entry, replacement?: Entry, disposedProject?: string) =>
      Effect.gen(function* () {
        const loaded = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        const disposed = yield* Effect.exit(
          Exit.isSuccess(loaded)
            ? disposedProject === undefined
              ? disposeContext(loaded.value)
              : Effect.gen(function* () {
                  yield* Effect.promise(() => runDisposers(directory))
                  yield* emitDisposed({ directory, ...(disposedProject ? { project: disposedProject } : {}) })
                })
            : Effect.void,
        )
        if (cache.get(directory) === entry) {
          if (replacement && Exit.isSuccess(disposed)) cache.set(directory, replacement)
          else cache.delete(directory)
        }
        if (replacement && Exit.isFailure(disposed)) {
          yield* Deferred.failCause(replacement.deferred, disposed.cause).pipe(Effect.ignore)
        }
        yield* Deferred.succeed(entry.closed, undefined).pipe(Effect.ignore)
        return yield* disposed
      }).pipe(Effect.uninterruptible)

    const armIdle = (directory: string, entry: Entry) =>
      Effect.suspend(() => {
        if (cache.get(directory) !== entry || entry.closing || entry.leases !== 0 || entry.idleCancel)
          return Effect.void
        const cancel = Deferred.makeUnsafe<void>()
        entry.idleCancel = cancel
        return Effect.raceFirst(
          Effect.sleep(idleTimeToLive).pipe(Effect.as(true)),
          Deferred.await(cancel).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((expired) => {
            if (!expired) {
              if (entry.idleCancel === cancel) entry.idleCancel = undefined
              return Effect.void
            }
            return claimIdleClosing(directory, entry, cancel).pipe(
              Effect.flatMap((claimed) => (claimed ? finishClosing(directory, entry) : Effect.void)),
              Effect.catchCause((cause) => Effect.logWarning("idle instance disposal failed", { directory, cause })),
            )
          }),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit) && !entry.closing) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
        if (Exit.isSuccess(exit)) yield* armIdle(directory, entry)
      })

    const startLoad = (directory: string, input: LoadInput, entry: Entry, action: "creating" | "reloading") =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`${action} instance`, { directory })
        yield* completeLoad(directory, input, entry)
      }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    const releaseEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        entry.leases--
        return cache.get(directory) === entry && !entry.closing && entry.leases === 0
      }).pipe(
        Effect.uninterruptible,
        Effect.flatMap((idle) => (idle ? armIdle(directory, entry) : Effect.void)),
      )

    const acquireEntry = (
      directory: string,
      input: LoadInput,
    ): Effect.Effect<{ entry: Entry; context: InstanceContext }> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing?.closing) {
            yield* restore(Deferred.await(existing.closed))
            return yield* acquireEntry(directory, input)
          }
          const entry = existing ?? makeEntry()
          if (!existing) {
            cache.set(directory, entry)
            yield* startLoad(directory, input, entry, "creating")
          }
          entry.leases++
          if (entry.idleCancel) Deferred.doneUnsafe(entry.idleCancel, Effect.void)
          entry.idleCancel = undefined
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.map((context) => ({ entry, context })),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseEntry(directory, entry) : Effect.void)),
          )
        }),
      )

    const acquire = (input: LoadInput): Effect.Effect<Lease> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.gen(function* () {
        const current = yield* acquireEntry(directory, input)
        const release = yield* Effect.cached(releaseEntry(directory, current.entry))
        return { context: current.context, release }
      }).pipe(Effect.withSpan("InstanceStore.acquire"))
    }

    const withInstance = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        acquire(input),
        (lease) => effect.pipe(Effect.provideService(InstanceRef, lease.context)),
        (lease) => lease.release,
      ).pipe(Effect.withSpan("InstanceStore.with"))

    const load = (input: LoadInput): Effect.Effect<InstanceContext> =>
      Effect.acquireUseRelease(
        acquire(input),
        (lease) => Effect.succeed(lease.context),
        (lease) => lease.release,
      ).pipe(Effect.withSpan("InstanceStore.load"))

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          if (previous?.closing) {
            yield* restore(Deferred.await(previous.closed))
            return yield* reload(input)
          }
          const entry = makeEntry()
          if (previous) {
            const claimed = yield* claimClosing(directory, previous)
            if (!claimed) {
              yield* restore(Deferred.await(previous.closed))
              return yield* reload(input)
            }
            yield* finishClosing(directory, previous, entry, input.project?.id ?? "")
          } else cache.set(directory, entry)
          yield* startLoad(directory, input, entry, "reloading")
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      const claimed = yield* claimClosing(ctx.directory, entry)
      if (claimed) yield* finishClosing(ctx.directory, entry)
      else yield* Deferred.await(entry.closed)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const claimed = yield* claimClosing(directory, entry)
      if (claimed) yield* finishClosing(directory, entry)
      else yield* Deferred.await(entry.closed)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const claimed = yield* claimClosing(item[0], item[1])
            if (claimed) yield* finishClosing(item[0], item[1])
            else yield* Deferred.await(item[1].closed)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      withInstance(input, effect)

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      acquire,
      with: withInstance,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"
