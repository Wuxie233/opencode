import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Fiber, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMClient, LLMEvent, Model } from "@opencode-ai/llm"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionCanonicalWindow } from "@opencode-ai/core/session/canonical-window"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { RequestExecutor } from "@opencode-ai/llm/route"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Database.node))
const sessionID = SessionV2.ID.make("ses_compaction_provider")
const created = DateTime.makeUnsafe(0)
const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, limits: { context: 100_000, output: 1_000 } })
  .model({ id: "gpt-5.6-sol" })
const request = LLM.request({ model, prompt: "Continue" })

const events = (published: Array<{ type: string; data: unknown }>) =>
  SessionEvent as never as {
    publish: (definition: typeof SessionEvent.Compaction.Ended, data: unknown) => Effect.Effect<unknown>
  }

const eventService = (published: Array<{ type: string; data: unknown }>) => ({
  publish: (definition: { readonly type: string }, data: unknown) =>
    Effect.sync(() => {
      published.push({ type: definition.type, data })
      return {} as never
    }),
  subscribe: () => Stream.empty,
  all: () => Stream.empty,
  durable: () => Stream.empty,
  listen: () => Effect.succeed(Effect.void),
  project: () => Effect.void,
  replay: () => Effect.void,
  replayAll: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  claim: () => Effect.void,
})

const entry = {
  seq: 5,
  message: SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_compaction_user"),
    type: "user",
    text: "A long request that needs a compacted provider window.",
    time: { created },
  }),
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "compaction",
      directory: "/project",
      title: "compaction",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
})

const response = (request: Parameters<RequestExecutor.Interface["execute"]>[0], output: unknown[]) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      JSON.stringify({ id: "cmp_response", created_at: 1, object: "response.compaction", output, usage: {} }),
      { headers: { "content-type": "application/json" } },
    ),
  )

describe("provider compaction orchestration", () => {
  it.effect("persists a validated provider window without creating a local summary", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      let calls = 0
      const output = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier" }] },
        { type: "compaction", encrypted_content: "opaque", created_by: "provider" },
      ]
      const published: Array<{ type: string; data: unknown }> = []
      const compaction = SessionCompaction.make({
        events: eventService(published),
        llm: { prepare: LLMClient.prepare, stream: () => Stream.empty },
        executor: {
          execute: (request) =>
            Effect.sync(() => {
              calls++
              return response(request, output)
            }),
        },
        db,
        config: [],
      })

      expect(yield* compaction.compact({ sessionID, entries: [entry], model, request })).toBe(true)
      expect(calls).toBe(1)
      expect(published).toHaveLength(0)
      expect(
        yield* SessionCanonicalWindow.load(db, {
          sessionID,
          providerID: "openai",
          modelID: "gpt-5.6-sol",
          routeID: "openai-responses",
        }),
      ).toEqual({ sourceSeq: 5, items: output })
    }),
  )

  it.effect("falls back to local summary when provider output is invalid", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const key = { sessionID, providerID: "openai", modelID: "gpt-5.6-sol", routeID: "openai-responses" }
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 3,
        items: [{ type: "compaction", encrypted_content: "old" }],
      })
      const published: Array<{ type: string; data: unknown }> = []
      const compaction = SessionCompaction.make({
        events: eventService(published),
        llm: {
          prepare: LLMClient.prepare,
          stream: () => Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "## Goal\n- Continue" })]),
        },
        executor: { execute: (request) => Effect.sync(() => response(request, [{ type: "message" }])) },
        db,
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                keep: new ConfigCompaction.Keep({ tokens: 1 }),
              }),
            }),
          }),
        ],
      })

      expect(yield* compaction.compact({ sessionID, entries: [entry], model, request })).toBe(true)
      expect(published.some((event) => event.type === SessionEvent.Compaction.Ended.type)).toBe(true)
      expect(yield* SessionCanonicalWindow.load(db, key)).toBeUndefined()
    }),
  )

  it.effect("falls back to local summary when canonical persistence fails", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const failing = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") return () => Effect.fail(new Error("canonical persistence unavailable"))
          return Reflect.get(target, property, receiver)
        },
      }) as typeof db
      const published: Array<{ type: string; data: unknown }> = []
      const compaction = SessionCompaction.make({
        events: eventService(published),
        llm: {
          prepare: LLMClient.prepare,
          stream: () =>
            Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "local persistence fallback" })]),
        },
        executor: {
          execute: (request) =>
            Effect.sync(() => response(request, [{ type: "compaction", encrypted_content: "uncommitted" }])),
        },
        db: failing,
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                keep: new ConfigCompaction.Keep({ tokens: 1 }),
              }),
            }),
          }),
        ],
      })

      expect(yield* compaction.compact({ sessionID, entries: [entry], model, request })).toBe(true)
      expect(published.some((event) => event.type === SessionEvent.Compaction.Ended.type)).toBe(true)
    }),
  )

  it.effect("local mode never calls the provider compact endpoint", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      let calls = 0
      const compaction = SessionCompaction.make({
        events: eventService([]),
        llm: {
          prepare: LLMClient.prepare,
          stream: () => Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "local" })]),
        },
        executor: {
          execute: () =>
            Effect.sync(() => {
              calls++
              throw new Error("must not call")
            }),
        },
        db,
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                mode: "local",
                keep: new ConfigCompaction.Keep({ tokens: 1 }),
              }),
            }),
          }),
        ],
      })

      expect(yield* compaction.compact({ sessionID, entries: [entry], model, request })).toBe(true)
      expect(calls).toBe(0)
    }),
  )

  it.effect("falls back locally instead of recompacting an equal-source canonical window", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      let calls = 0
      const compaction = SessionCompaction.make({
        events: eventService([]),
        llm: {
          prepare: LLMClient.prepare,
          stream: () => Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "local equal-source" })]),
        },
        executor: {
          execute: () =>
            Effect.sync(() => {
              calls++
              throw new Error("must not call")
            }),
        },
        db,
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                keep: new ConfigCompaction.Keep({ tokens: 1 }),
              }),
            }),
          }),
        ],
      })

      expect(
        yield* compaction.compact({
          sessionID,
          entries: [entry],
          model,
          request,
          canonicalSourceSeq: entry.seq,
        }),
      ).toBe(true)
      expect(calls).toBe(0)
    }),
  )

  it.effect("times out provider compaction and falls back without persisting a canonical window", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const key = { sessionID, providerID: "openai", modelID: "gpt-5.6-sol", routeID: "openai-responses" }
      const published: Array<{ type: string; data: unknown }> = []
      const compaction = SessionCompaction.make({
        events: eventService(published),
        llm: {
          prepare: LLMClient.prepare,
          stream: () => Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "local timeout fallback" })]),
        },
        executor: { execute: () => Effect.never },
        db,
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                keep: new ConfigCompaction.Keep({ tokens: 1 }),
              }),
            }),
          }),
        ],
      })

      const fiber = yield* compaction.compact({ sessionID, entries: [entry], model, request }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.minutes(5))

      expect(yield* Fiber.join(fiber)).toBe(true)
      expect(published.some((event) => event.type === SessionEvent.Compaction.Ended.type)).toBe(true)
      expect(yield* SessionCanonicalWindow.load(db, key)).toBeUndefined()
    }),
  )
})
