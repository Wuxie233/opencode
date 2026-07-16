import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Context, Deferred, Duration, Effect, Layer } from "effect"
import type { SessionID } from "./schema"

export interface Interface {
  readonly wait: (input: {
    readonly sessionID: SessionID
    readonly duration: Duration.Duration
    readonly ready: Effect.Effect<void>
  }) => Effect.Effect<void>
  readonly wake: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetryControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() =>
      Effect.succeed({
        next: 0,
        gates: new Map<SessionID, { readonly id: number; readonly deferred: Deferred.Deferred<void> }>(),
      }),
    )

    const wait = Effect.fn("SessionRetryControl.wait")(function* (input: {
      readonly sessionID: SessionID
      readonly duration: Duration.Duration
      readonly ready: Effect.Effect<void>
    }) {
      const data = yield* InstanceState.get(state)
      const id = ++data.next
      const deferred = yield* Deferred.make<void>()
      data.gates.set(input.sessionID, { id, deferred })

      yield* Effect.gen(function* () {
        yield* input.ready
        yield* Effect.raceFirst(Effect.sleep(input.duration), Deferred.await(deferred))
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (data.gates.get(input.sessionID)?.id === id) data.gates.delete(input.sessionID)
          }),
        ),
      )
    })

    const wake = Effect.fn("SessionRetryControl.wake")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return yield* Effect.sync(() => {
        const gate = data.gates.get(sessionID)
        if (!gate) return false
        data.gates.delete(sessionID)
        return Deferred.doneUnsafe(gate.deferred, Effect.void)
      })
    })

    return Service.of({ wait, wake })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as SessionRetryControl from "./retry-control"
