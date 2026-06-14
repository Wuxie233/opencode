import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { InstanceState } from "@/effect/instance-state"
import { PluginRoute } from "@/plugin/route"

const toWebRequest = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  if (request.source instanceof Request) return request.source
  const init: RequestInit = {
    method: request.method,
    headers: request.headers as Record<string, string>,
  }
  if (request.method !== "GET" && request.method !== "HEAD") init.body = yield* request.arrayBuffer
  return new Request(new URL(request.url, "http://localhost"), init)
})

const toServerResponse = Effect.fnUntraced(function* (response: Response) {
  const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
  return HttpServerResponse.uint8Array(body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
  })
})

export const pluginRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("*", `${PluginRoute.PREFIX}*`, (request) =>
      Effect.gen(function* () {
        const parsed = PluginRoute.parse(new URL(request.url, "http://localhost").pathname)
        if (!parsed) return HttpServerResponse.empty({ status: 404 })
        const scope = yield* InstanceState.directory
        const handler = PluginRoute.lookup(scope, parsed.pluginID, request.method, parsed.path)
        if (!handler) return HttpServerResponse.empty({ status: 404 })
        const webRequest = yield* toWebRequest(request)
        const response = yield* Effect.promise(async () => handler(webRequest))
        return yield* toServerResponse(response)
      }),
    )
  }),
)
