import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Tracer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const context = Context.empty() as Context.Context<unknown>
const spans: Tracer.NativeSpan[] = []
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Session.node),
    httpApiLayer.pipe(Layer.provide(Layer.succeed(Tracer.Tracer, tracer))),
  ),
)

afterEach(async () => {
  spans.length = 0
  mock.restore()
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "pages sync history against a stable watermark",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const sessions = yield* Effect.all([
          Session.use.create({ title: "sync-page-1" }),
          Session.use.create({ title: "sync-page-2" }),
          Session.use.create({ title: "sync-page-3" }),
        ])

        const firstResponse = yield* requestInDirectory("/sync/v2/history", tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ known: {}, limit: 1 }),
        })
        expect(firstResponse.status).toBe(200)
        const first = (yield* firstResponse.json) as {
          events: Array<{ id: string; aggregate_id: string; seq: number }>
          cursor: string
          watermark: string
          state: string
          hasMore: boolean
        }
        expect(first.events).toHaveLength(1)
        expect(first.cursor).toMatch(/^\d+$/)
        expect(first.watermark).toMatch(/^\d+$/)
        expect(first.hasMore).toBe(true)

        const late = yield* Session.use.create({ title: "sync-page-late" })
        const events = [...first.events]
        let page = first
        while (page.hasMore) {
          const response = yield* requestInDirectory("/sync/v2/history", tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({
              known: {},
              cursor: page.cursor,
              watermark: page.watermark,
              state: page.state,
              limit: 1,
            }),
          })
          page = (yield* response.json) as typeof first
          events.push(...page.events)
        }
        expect(new Set(events.map((event) => event.aggregate_id))).toEqual(new Set(sessions.map((session) => session.id)))
        expect(events.some((event) => event.aggregate_id === late.id)).toBe(false)

        const changedState = yield* requestInDirectory("/sync/v2/history", tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            known: { [sessions[0].id]: 0 },
            cursor: first.cursor,
            watermark: first.watermark,
            state: first.state,
            limit: 1,
          }),
        })
        expect(changedState.status).toBe(400)

        const legacy = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(Array.isArray(yield* legacy.json)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "advances bounded history across filtered candidates",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const known = yield* Session.use.create({ title: "sync-known" })
        const pending = yield* Session.use.create({ title: "sync-pending" })

        const first = yield* requestInDirectory(SyncPaths.historyV2, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ known: { [known.id]: 0 }, limit: 1 }),
        })
        expect(first.status).toBe(200)
        const page = (yield* first.json) as {
          events: Array<{ aggregate_id: string }>
          cursor: string
          watermark: string
          state: string
          hasMore: boolean
        }
        expect(page.events).toEqual([])
        expect(page.cursor).not.toBe("0")
        expect(page.hasMore).toBe(true)

        for (const cursor of ["", " 1 ", "+1", "1.0", "1e2", "0x10"]) {
          const malformed = yield* requestInDirectory(SyncPaths.historyV2, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({
              known: { [known.id]: 0 },
              cursor,
              watermark: page.watermark,
              state: page.state,
              limit: 1,
            }),
          })
          expect(malformed.status).toBe(400)
        }

        const second = yield* requestInDirectory(SyncPaths.historyV2, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            known: { [known.id]: 0 },
            cursor: page.cursor,
            watermark: page.watermark,
            state: page.state,
            limit: 1,
          }),
        })
        expect(second.status).toBe(200)
        expect(((yield* second.json) as typeof page).events.map((event) => event.aggregate_id)).toEqual([pending.id])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync" })

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)
        const historySpan = spans.findLast((span) => span.attributes.has("sync.history.known_aggregates"))
        expect(historySpan?.attributes.get("sync.history.known_aggregates")).toBe(0)
        expect(historySpan?.attributes.get("sync.history.events")).toBe(rows.length)
        expect(historySpan?.attributes.get("sync.history.aggregates")).toBe(
          new Set(rows.map((row) => row.aggregate_id)).size,
        )

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.historyV2,
            body: { known: {}, cursor: "1" },
          },
          {
            path: SyncPaths.historyV2,
            body: { known: {}, limit: 1001 },
          },
          {
            path: SyncPaths.historyV2,
            body: { known: {}, cursor: "-1", watermark: "1", state: "state" },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-opencode-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
