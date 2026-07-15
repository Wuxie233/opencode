import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { EffectBridge } from "@/effect/bridge"
import { InstanceStore } from "@/project/instance-store"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { IncomingMessage } from "node:http"
import { Effect, Exit, Layer, Scope, Stream } from "effect"
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext | HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const scope = yield* Scope.make()
    const ctx = yield* store.load({ directory: decode(route.directory) }).pipe(Scope.provide(scope))
    const response = yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    )
    if (response.body._tag !== "Stream") {
      yield* Scope.close(scope, Exit.void)
      return response
    }
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.source instanceof IncomingMessage) {
      const bridge = yield* EffectBridge.make()
      const incoming = NodeHttpServerRequest.toIncomingMessage(request)
      const onSocketClose = () => {
        bridge.fork(Scope.close(scope, Exit.void))
      }
      incoming.socket.once("close", onSocketClose)
      yield* Scope.addFinalizer(scope, Effect.sync(() => incoming.socket.off("close", onSocketClose)))
    }
    return HttpServerResponse.setBody(
      response,
      HttpBody.stream(
        response.body.stream.pipe(Stream.ensuring(Scope.close(scope, Exit.void))),
        response.body.contentType,
        response.body.contentLength,
      ),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)

// Router-level twin of `instanceContextLayer` for raw `HttpRouter.use(...)` routes
// (such as the plugin route catch-all) that cannot declare HttpApiMiddleware on an
// endpoint. It shares the same `provideInstanceContext` core, so it requires the
// `WorkspaceRouteContext` provided by `workspaceRouterMiddleware`.
export const instanceRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return (effect) => provideInstanceContext(effect, store)
  }),
)
