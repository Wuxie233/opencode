import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Tracer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/database/sqlite.bun"

test("attributes sqlite permit wait, execution time, and returned rows", async () => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })

  await Effect.gen(function* () {
    const sql = yield* SqlClient
    const transactionStarted = yield* Deferred.make<void>()
    const releaseTransaction = yield* Deferred.make<void>()
    const transaction = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT 3 AS transaction_value`
          yield* Deferred.succeed(transactionStarted, undefined)
          yield* Deferred.await(releaseTransaction)
        }),
      )
      .pipe(Effect.forkScoped)

    yield* Deferred.await(transactionStarted)
    const query = yield* sql`SELECT 1 AS value UNION ALL SELECT 2 AS value`.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    expect(query.pollUnsafe()).toBeUndefined()

    yield* Deferred.succeed(releaseTransaction, undefined)
    yield* Fiber.join(transaction)
    expect(yield* Fiber.join(query)).toEqual([{ value: 1 }, { value: 2 }])
  }).pipe(
    Effect.withSpan("outer"),
    Effect.provide(layer({ filename: ":memory:", disableWAL: true })),
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.scoped,
    Effect.runPromise,
  )

  const querySpan = spans.findLast(
    (span) => span.name === "sql.execute" && span.attributes.get("db.query.text")?.toString().includes("UNION ALL"),
  )
  const transactionQuerySpan = spans.findLast(
    (span) =>
      span.name === "sql.execute" && span.attributes.get("db.query.text")?.toString().includes("transaction_value"),
  )
  const transactionSpan = spans.findLast((span) => span.name === "sql.transaction")
  const outerSpan = spans.findLast((span) => span.name === "outer")
  expect(querySpan?.status._tag).toBe("Ended")
  expect(Option.getOrUndefined(transactionQuerySpan?.parent ?? Option.none())?.spanId).toBe(transactionSpan?.spanId)
  expect(querySpan?.attributes.get("db.sqlite.permit_wait_ms")).toBeNumber()
  expect(querySpan?.attributes.get("db.sqlite.execute_ms")).toBeNumber()
  expect(querySpan?.attributes.get("db.response.returned_rows")).toBe(2)
  expect(transactionSpan?.attributes.get("db.sqlite.permit_wait_ms")).toBeNumber()
  expect(transactionSpan?.attributes.get("db.sqlite.execute_ms")).toBeNumber()
  expect(outerSpan?.attributes.has("db.sqlite.permit_wait_ms")).toBe(false)
  expect(outerSpan?.attributes.has("db.sqlite.execute_ms")).toBe(false)
  expect(outerSpan?.attributes.has("db.response.returned_rows")).toBe(false)
  expect(spans.filter((span) => span.name.startsWith("Sqlite."))).toEqual([])
})
