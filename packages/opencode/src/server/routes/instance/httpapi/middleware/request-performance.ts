import { Context, Effect } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest } from "effect/unstable/http"

const phases = ["workspace_route", "instance_acquire", "handler", "proxy", "fence_wait"] as const

type Phase = (typeof phases)[number]
type Timing = {
  readonly started: number
  readonly phases: Partial<Record<Phase, number>>
}

const RequestTiming = Context.Reference<Timing | undefined>("@opencode/HttpRequestTiming", {
  defaultValue: () => undefined,
})

function elapsed(started: number) {
  return Math.max(0, Math.round(performance.now() - started))
}

export function measure<A, E, R>(phase: Phase, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const timing = yield* RequestTiming
    if (!timing) return yield* effect
    const started = performance.now()
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          timing.phases[phase] = (timing.phases[phase] ?? 0) + elapsed(started)
        }),
      ),
    )
  })
}

export function event(input: { method: string; route: HttpRouter.PathInput; status: number; timing: Timing }) {
  return {
    event: "http_request",
    method: input.method,
    route: typeof input.route === "string" ? input.route : "<pattern>",
    status: input.status,
    total_ms: elapsed(input.timing.started),
    ...Object.fromEntries(
      phases.flatMap((phase) => {
        const duration = input.timing.phases[phase]
        return duration === undefined ? [] : [[`${phase}_ms`, duration]]
      }),
    ),
  }
}

export const requestPerformanceLayer = HttpRouter.middleware((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const route = yield* HttpRouter.RouteContext
    if (route.route.path === "/*") return yield* effect
    const timing: Timing = { started: performance.now(), phases: {} }
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.logInfo(event({ method: request.method, route: route.route.path, status: response.status, timing })).pipe(
        Effect.as(response),
      ),
    )
    return yield* effect.pipe(Effect.provideService(RequestTiming, timing))
  }),
).layer
