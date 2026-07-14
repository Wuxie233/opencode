import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventSyncOrderTable } from "@opencode-ai/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { max } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ReplayPayload, SessionPayload } from "../groups/sync"
import { HistoryPagePayload, HistoryPayload } from "@/sync/schema"

const HISTORY_PAGE_LIMIT = 500

function historyState(known: Record<string, number>) {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(known).sort(([left], [right]) => left.localeCompare(right))))
    .digest("base64url")
}

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = Object.entries(ctx.payload)
      yield* Effect.annotateCurrentSpan("sync.history.known_aggregates", exclude.length)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(
          exclude.length > 0
            ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
            : undefined,
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.annotateCurrentSpan({
        "sync.history.events": rows.length,
        "sync.history.aggregates": new Set(rows.map((row) => row.aggregate_id)).size,
      })
      return rows
    })

    const historyV2 = Effect.fn("SyncHttpApi.historyV2")(function* (ctx: {
      payload: typeof HistoryPagePayload.Type
    }) {
      const continuation =
        ctx.payload.cursor !== undefined || ctx.payload.watermark !== undefined || ctx.payload.state !== undefined
      if (
        continuation &&
        (ctx.payload.cursor === undefined || ctx.payload.watermark === undefined || ctx.payload.state === undefined)
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      if (!continuation && ctx.payload.state !== undefined) return yield* new HttpApiError.BadRequest({})

      const state = historyState(ctx.payload.known)
      if (ctx.payload.state !== undefined && ctx.payload.state !== state) {
        return yield* new HttpApiError.BadRequest({})
      }
      const cursor = ctx.payload.cursor ?? 0
      const watermark =
        ctx.payload.watermark ??
        ((yield* db
          .select({ ordinal: max(EventSyncOrderTable.ordinal) })
          .from(EventSyncOrderTable)
          .get()
          .pipe(Effect.orDie))?.ordinal ?? 0)
      if (cursor > watermark) return yield* new HttpApiError.BadRequest({})

      const limit = ctx.payload.limit ?? HISTORY_PAGE_LIMIT
      const rows = yield* db
        .select({
          ordinal: EventSyncOrderTable.ordinal,
          id: EventTable.id,
          aggregate_id: EventTable.aggregate_id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: EventTable.data,
        })
        .from(EventSyncOrderTable)
        .innerJoin(EventTable, eq(EventSyncOrderTable.event_id, EventTable.id))
        .where(and(gt(EventSyncOrderTable.ordinal, cursor), lte(EventSyncOrderTable.ordinal, watermark)))
        .orderBy(asc(EventSyncOrderTable.ordinal))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const candidates = rows.slice(0, limit)
      const hasMore = rows.length > limit
      const nextCursor = hasMore ? (candidates.at(-1)?.ordinal ?? cursor) : watermark
      const events = candidates
        .filter((event) => event.seq > (ctx.payload.known[event.aggregate_id] ?? -1))
        .map(({ ordinal: _, ...event }) => event)
      yield* Effect.annotateCurrentSpan({
        "sync.history.v2.scanned": candidates.length,
        "sync.history.v2.events": events.length,
        "sync.history.v2.has_more": hasMore,
      })
      return { events, cursor: nextCursor, watermark, state, hasMore }
    })

    return handlers
      .handle("start", start)
      .handle("replay", replay)
      .handle("steal", steal)
      .handle("history", history)
      .handle("historyV2", historyV2)
  }),
)
