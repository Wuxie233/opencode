import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Auth, LLM, Model } from "../../src"
import type { RequestExecutor } from "../../src/route"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { OpenAIResponsesCompact } from "../../src/protocols/openai-responses-compact"
import { it } from "../lib/effect"

const model = OpenAIResponses.route
  .with({
    endpoint: { baseURL: "https://api.openai.test/v1/", query: { "api-version": "v1" } },
    auth: Auth.bearer("compact-key"),
  })
  .model({ id: "gpt-5.6-sol" })

const request = LLM.request({
  model,
  prompt: "Continue",
  http: {
    body: { unsupported_for_compact: true },
    headers: { "x-trace": "trace-1" },
    query: { region: "test" },
  },
})

const executor = (body: unknown, inspect?: (request: HttpClientRequest.HttpClientRequest) => void) =>
  ({
    execute: (input) =>
      Effect.gen(function* () {
        inspect?.(input)
        return HttpClientResponse.fromWeb(
          input,
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
        )
      }),
  }) satisfies RequestExecutor.Interface

describe("OpenAI Responses compact", () => {
  it.effect("reuses route endpoint, query, auth, and request headers", () =>
    Effect.gen(function* () {
      const output = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ]
      const result = yield* OpenAIResponsesCompact.compact({
        request,
        body: {
          model: "gpt-5.6-sol",
          input: output,
          instructions: "Preserve task state",
          prompt_cache_key: "session-key",
          service_tier: "priority",
        },
        executor: executor(
          { id: "resp_compact", created_at: 1, object: "response.compaction", output, usage: {} },
          (input) => {
            expect(input.url).toContain("/v1/responses/compact")
            expect(input.url).toContain("api-version=v1")
            expect(input.url).toContain("region=test")
            expect(input.headers.authorization).toBe("Bearer compact-key")
            expect(input.headers["x-trace"]).toBe("trace-1")
            expect(
              JSON.parse(String(input.body._tag === "Uint8Array" ? new TextDecoder().decode(input.body.body) : "{}")),
            ).toEqual({
              model: "gpt-5.6-sol",
              input: output,
              instructions: "Preserve task state",
              prompt_cache_key: "session-key",
              service_tier: "priority",
            })
          },
        ),
      })
      expect(result.output).toEqual(output)
    }),
  )

  it.effect("rejects malformed output without a terminal compaction item", () =>
    OpenAIResponsesCompact.compact({
      request,
      body: { model: "gpt-5.6-sol", input: [] },
      executor: executor({
        id: "resp_compact",
        created_at: 1,
        object: "response.compaction",
        output: [{ type: "message", role: "user", content: [] }],
        usage: {},
      }),
    }).pipe(
      Effect.flip,
      Effect.map((error) => expect(error.message).toContain("compaction item")),
    ),
  )

  it.effect("accepts the gateway compaction_summary alias and preserves opaque fields", () =>
    Effect.gen(function* () {
      const output = [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Earlier" }],
          provider_opaque: { trace: "kept" },
        },
        {
          type: "compaction_summary",
          id: "cmp_alias",
          encrypted_content: "opaque-alias",
          status: "completed",
          summary: [{ type: "summary_text", text: "hidden" }],
          opaque: { source: "gateway" },
        },
      ]
      const result = yield* OpenAIResponsesCompact.compact({
        request,
        body: { model: "gpt-5.6-sol", input: output },
        executor: executor({
          id: "resp_alias",
          created_at: 2,
          object: "response.compaction",
          output,
          usage: { input_tokens: 3, custom: { retained: true } },
          response_opaque: { retained: true },
        }),
      })

      expect(result.output).toEqual(output)
      expect(result.usage).toEqual({ input_tokens: 3, custom: { retained: true } })
      expect(result.response_opaque).toEqual({ retained: true })
    }),
  )

  it.effect("accepts multiple compaction items in order and the gateway response metadata shape", () =>
    Effect.gen(function* () {
      const output = [
        { type: "compaction", encrypted_content: "first" },
        { type: "message", role: "user", content: [] },
        { type: "compaction_summary", encrypted_content: "last" },
      ]
      const result = yield* OpenAIResponsesCompact.compact({
        request,
        body: { model: "gpt-5.6-sol", input: [] },
        executor: executor({ id: "resp_multiple", object: "response", output }),
      })

      expect(result.output).toEqual(output)
      expect(result.object).toBe("response")
      expect(result.created_at).toBeUndefined()
      expect(result.usage).toBeUndefined()
    }),
  )

  it.effect("routes only the approved Sol Luna Terra model IDs", () =>
    Effect.sync(() => {
      expect(OpenAIResponsesCompact.supported(model)).toBe(true)
      expect(OpenAIResponsesCompact.supported(Model.update(model, { id: "gpt-5.6-luna" }))).toBe(true)
      expect(OpenAIResponsesCompact.supported(Model.update(model, { id: "gpt-5.6-terra" }))).toBe(true)
      expect(OpenAIResponsesCompact.supported(Model.update(model, { id: "gpt-5.4" }))).toBe(false)
      expect(OpenAIResponsesCompact.supported(Model.update(model, { provider: "wuxie-openai" }))).toBe(true)
    }),
  )
})
