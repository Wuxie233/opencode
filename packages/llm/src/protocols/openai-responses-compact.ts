import { Effect, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import * as LLM from "../llm"
import type { LLMRequest, Model } from "../schema"
import { resolveRequestOptions } from "../route/client"
import { Endpoint } from "../route/endpoint"
import type { Interface as RequestExecutor } from "../route/executor"
import { HttpTransport } from "../route/transport"
import * as ProviderShared from "./shared"
import { OpenAIOptions } from "./utils/openai-options"

const PATH = "/responses/compact"

export const Body = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Unknown),
  instructions: Schema.optional(Schema.String),
  prompt_cache_key: Schema.optional(Schema.String),
  service_tier: Schema.optional(OpenAIOptions.OpenAIServiceTier),
})
export type Body = Schema.Schema.Type<typeof Body>

const CompactionItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals(["compaction", "compaction_summary"]),
    id: Schema.optional(Schema.String),
    encrypted_content: Schema.String,
    created_by: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

const OutputItem = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
])

export const Response = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    created_at: Schema.optional(Schema.Number),
    object: Schema.optional(Schema.Literals(["response", "response.compaction"])),
    output: Schema.Array(OutputItem),
    usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type Response = Schema.Schema.Type<typeof Response>

const isCompactionItem = Schema.is(CompactionItem)

export const supported = (model: Model) =>
  model.route.protocol === "openai-responses" &&
  (model.id === "gpt-5.6-sol" || model.id === "gpt-5.6-luna" || model.id === "gpt-5.6-terra")

const invalid = (message: string) => Effect.fail(ProviderShared.eventError("openai-responses", message))

export const compact = Effect.fn("OpenAIResponsesCompact.compact")(function* (input: {
  readonly request: LLMRequest
  readonly body: Body
  readonly executor: RequestExecutor
}) {
  if (!supported(input.request.model)) return yield* invalid("Model does not support provider-native compaction")
  const route = input.request.model.route
  const resolved = resolveRequestOptions(input.request)
  const request = LLM.updateRequest(resolved, {
    http: resolved.http ? { headers: resolved.http.headers, query: resolved.http.query } : undefined,
  })
  const endpoint = Endpoint.merge(route.endpoint, { path: PATH })
  const parts = yield* HttpTransport.jsonRequestParts({
    body: input.body,
    request,
    endpoint,
    auth: route.auth,
    encodeBody: Schema.encodeSync(Schema.fromJsonString(Body)),
    headers: route.headers,
  })
  const response = yield* input.executor.execute(
    ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
  )
  const result = yield* HttpClientResponse.schemaBodyJson(Response)(response).pipe(
    Effect.mapError(() => ProviderShared.eventError(route.id, "Invalid OpenAI compact response")),
  )
  if (!isCompactionItem(result.output[result.output.length - 1]))
    return yield* invalid("OpenAI compact response must end with a compaction item")
  return result
})

export * as OpenAIResponsesCompact from "./openai-responses-compact"
