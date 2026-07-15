import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { type InstanceContext } from "./instance-context"
import { InstanceStore, type LoadInput } from "./instance-store"

// Bridge for Promise/ALS callers that cannot yet yield InstanceStore.Service.
// Delete this module once those callers are migrated to Effect boundaries that
// provide InstanceStore directly.

export const provide = <A>(input: LoadInput, use: (ctx: InstanceContext) => Promise<A>) =>
  AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        input,
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) return yield* Effect.die(new Error("missing instance context"))
          const instance = ctx
          return yield* Effect.promise(() => use(instance))
        }),
      ),
    ),
  )
export const disposeInstance = (ctx: InstanceContext) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx)))
export const disposeAllInstances = () => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))
export const reloadInstance = (input: LoadInput) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload(input)))

export * as InstanceRuntime from "./instance-runtime"
