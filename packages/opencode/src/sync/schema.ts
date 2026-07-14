import { EventV2 } from "@opencode-ai/core/event"
import { NonNegativeInt, PositiveInt, optional, statics } from "@opencode-ai/core/schema"
import { Schema, SchemaGetter } from "effect"

import { Identifier } from "@/id/id"

export const EventID = Schema.String.check(Schema.isStartsWith("evt")).pipe(
  Schema.brand("EventID"),
  statics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("event", id)),
  })),
)

export const HistoryPayload = Schema.Record(Schema.String, NonNegativeInt)
export const HistoryEvent = Schema.Struct({
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
const HistoryCursorValue = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const HistoryCursor = Schema.String.check(Schema.isPattern(/^[0-9]+$/)).pipe(
  Schema.decodeTo(HistoryCursorValue, {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transform(String),
  }),
)
const HistoryPageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(1000))
export const HistoryPagePayload = Schema.Struct({
  known: HistoryPayload,
  cursor: optional(HistoryCursor),
  watermark: optional(HistoryCursor),
  state: optional(Schema.String),
  limit: optional(HistoryPageLimit),
})
export const HistoryPageResponse = Schema.Struct({
  events: Schema.Array(HistoryEvent),
  cursor: HistoryCursor,
  watermark: HistoryCursor,
  state: Schema.String,
  hasMore: Schema.Boolean,
})
