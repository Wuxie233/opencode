import { Cause, Duration, Effect, Exit, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly version: { value: number }
  readonly keys: Map<string, Set<string>>
}

function cacheKey<A, E, R>(self: InstanceState<A, E, R>, directory: string) {
  const key = `${self.version.value}:${directory}`
  const keys = self.keys.get(directory)
  if (keys) keys.add(key)
  if (!keys) self.keys.set(directory, new Set([key]))
  return key
}

function invalidateDirectory<A, E, R>(self: InstanceState<A, E, R>, directory: string) {
  const keys = self.keys.get(directory)
  if (!keys) return Effect.void
  self.keys.delete(directory)
  return Effect.forEach(keys, (key) => ScopedCache.invalidate(self.cache, key), { discard: true })
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.makeWith<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      // A cancelled first lookup must not poison this directory for every later caller.
      timeToLive: (exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Duration.zero : Duration.infinity,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const version = { value: 0 }
    const keys = new Map<string, Set<string>>()
    const self: InstanceState<A, E, Exclude<R, Scope.Scope>> = { [TypeId]: TypeId, cache, version, keys }
    const off = registerDisposer((directory) => Effect.runPromise(invalidateDirectory(self, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return self
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const current = yield* directory
    return yield* ScopedCache.get(self.cache, cacheKey(self, current))
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const current = yield* directory
    return yield* ScopedCache.has(self.cache, cacheKey(self, current))
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* invalidateDirectory(self, yield* directory)
  })

export const invalidateAll = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    self.keys.clear()
    yield* ScopedCache.invalidateAll(self.cache)
  })

// Future lookups use a fresh generation while existing scoped values remain valid.
export const rotate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.sync(() => {
    self.version.value++
  })

export * as InstanceState from "./instance-state"
