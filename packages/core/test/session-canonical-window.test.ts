import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionCanonicalWindow } from "@opencode-ai/core/session/canonical-window"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Database.node))
const sessionID = SessionV2.ID.make("ses_canonical_window")
const key = { sessionID, providerID: "openai", modelID: "gpt-5.6-sol", routeID: "openai-responses" }

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
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
})

describe("SessionCanonicalWindow", () => {
  it.effect("atomically replaces one exact model window", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 4,
        items: [{ type: "compaction", encrypted_content: "first" }],
      })
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "second" }],
      })
      expect(yield* SessionCanonicalWindow.load(db, key)).toEqual({
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "second" }],
      })
    }),
  )

  it.effect("keeps provider model route and variant keys isolated", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* SessionCanonicalWindow.replace(db, { ...key, variant: "high", sourceSeq: 1, items: [] })
      expect(yield* SessionCanonicalWindow.load(db, key)).toBeUndefined()
      expect(yield* SessionCanonicalWindow.load(db, { ...key, variant: "high" })).toEqual({ sourceSeq: 1, items: [] })
    }),
  )

  it.effect("does not let a stale compact result overwrite a newer source sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "newer" }],
      })
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 4,
        items: [{ type: "compaction", encrypted_content: "stale" }],
      })
      expect(yield* SessionCanonicalWindow.load(db, key)).toEqual({
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "newer" }],
      })
    }),
  )

  it.effect("does not let equal-source retries replace an already committed window", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "first-commit" }],
      })
      yield* SessionCanonicalWindow.replace(db, {
        ...key,
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "late-retry" }],
      })
      expect(yield* SessionCanonicalWindow.load(db, key)).toEqual({
        sourceSeq: 9,
        items: [{ type: "compaction", encrypted_content: "first-commit" }],
      })
    }),
  )

  it.effect("concurrent replacement converges on the highest source sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* Effect.all(
        [3, 11, 7].map((sourceSeq) =>
          SessionCanonicalWindow.replace(db, {
            ...key,
            sourceSeq,
            items: [{ type: "compaction", encrypted_content: String(sourceSeq) }],
          }),
        ),
        { concurrency: "unbounded" },
      )
      expect(yield* SessionCanonicalWindow.load(db, key)).toEqual({
        sourceSeq: 11,
        items: [{ type: "compaction", encrypted_content: "11" }],
      })
    }),
  )

  it.effect("clears every canonical window for a Session", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* SessionCanonicalWindow.replace(db, { ...key, sourceSeq: 1, items: [] })
      yield* SessionCanonicalWindow.clear(db, sessionID)
      expect(yield* SessionCanonicalWindow.load(db, key)).toBeUndefined()
    }),
  )
})
