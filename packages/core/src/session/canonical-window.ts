export * as SessionCanonicalWindow from "./canonical-window"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"
import { SessionCanonicalWindowTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export type Key = {
  readonly sessionID: SessionSchema.ID
  readonly providerID: string
  readonly modelID: string
  readonly routeID: string
  readonly variant?: string
}

const whereKey = (key: Key) =>
  and(
    eq(SessionCanonicalWindowTable.session_id, key.sessionID),
    eq(SessionCanonicalWindowTable.provider_id, key.providerID),
    eq(SessionCanonicalWindowTable.model_id, key.modelID),
    eq(SessionCanonicalWindowTable.route_id, key.routeID),
    eq(SessionCanonicalWindowTable.variant, key.variant ?? ""),
  )

/** Load the exact provider/model/route canonical window for a Session. */
export const load = Effect.fn("SessionCanonicalWindow.load")(function* (db: DatabaseService, key: Key) {
  return yield* db
    .select({ sourceSeq: SessionCanonicalWindowTable.source_seq, items: SessionCanonicalWindowTable.items })
    .from(SessionCanonicalWindowTable)
    .where(whereKey(key))
    .get()
})

/** Atomically replace one canonical provider window after full response validation. */
export const replace = Effect.fn("SessionCanonicalWindow.replace")(function* (
  db: DatabaseService,
  input: Key & { readonly sourceSeq: number; readonly items: ReadonlyArray<unknown> },
) {
  yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* tx
          .select({ sourceSeq: SessionCanonicalWindowTable.source_seq })
          .from(SessionCanonicalWindowTable)
          .where(whereKey(input))
          .get()
        if (current && current.sourceSeq >= input.sourceSeq) return
        yield* tx
          .insert(SessionCanonicalWindowTable)
          .values({
            session_id: input.sessionID,
            provider_id: input.providerID,
            model_id: input.modelID,
            route_id: input.routeID,
            variant: input.variant ?? "",
            source_seq: input.sourceSeq,
            items: [...input.items],
          })
          .onConflictDoUpdate({
            target: [
              SessionCanonicalWindowTable.session_id,
              SessionCanonicalWindowTable.provider_id,
              SessionCanonicalWindowTable.model_id,
              SessionCanonicalWindowTable.route_id,
              SessionCanonicalWindowTable.variant,
            ],
            set: { source_seq: input.sourceSeq, items: [...input.items], time_updated: Date.now() },
          })
          .run()
      }),
    { behavior: "immediate" },
  )
})

/** Clear all provider canonical state for a Session. */
export const clear = Effect.fn("SessionCanonicalWindow.clear")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db.delete(SessionCanonicalWindowTable).where(eq(SessionCanonicalWindowTable.session_id, sessionID)).run()
})
