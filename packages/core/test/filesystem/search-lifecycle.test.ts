import { beforeEach, describe, expect, mock } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Entry } from "@opencode-ai/schema/filesystem"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import type { Fff } from "../../src/filesystem/fff.node"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

let created = 0
let destroyed = 0
let createPicker: () => Fff.Result<Fff.Picker>

const picker = (): Fff.Picker => ({
  destroy: () => {
    destroyed++
  },
  isScanning: () => false,
  waitForScan: async () => ({ ok: true, value: true }),
  refreshGitStatus: () => ({ ok: true, value: 0 }),
  fileSearch: () => ({
    ok: true,
    value: {
      items: [{ relativePath: "src/index.ts", fileName: "index.ts", modified: 0 }],
      scores: [{ total: 1 }],
      totalMatched: 1,
      totalFiles: 1,
    },
  }),
  glob: () => ({
    ok: true,
    value: {
      items: [{ relativePath: "src/index.ts", fileName: "index.ts", modified: 0 }],
      scores: [{ total: 1 }],
      totalMatched: 1,
      totalFiles: 1,
    },
  }),
  directorySearch: () => ({
    ok: true,
    value: {
      items: [{ relativePath: "src", dirName: "src", maxAccessFrecency: 0 }],
      scores: [{ total: 1 }],
      totalMatched: 1,
      totalDirs: 1,
    },
  }),
  mixedSearch: () => ({
    ok: true,
    value: {
      items: [
        {
          type: "file",
          item: { relativePath: "src/index.ts", fileName: "index.ts", modified: 0 },
        },
      ],
      scores: [{ total: 1 }],
      totalMatched: 1,
      totalFiles: 1,
      totalDirs: 0,
    },
  }),
  grep: () => ({
    ok: true,
    value: {
      items: [],
      totalMatched: 0,
      totalFilesSearched: 0,
      totalFiles: 1,
      filteredFileCount: 0,
      nextCursor: null,
    },
  }),
  trackQuery: () => ({ ok: true, value: true }),
  getHistoricalQuery: () => ({ ok: true, value: null }),
})

mock.module("@ff-labs/fff-bun", () => ({
  FileFinder: {
    isAvailable: () => true,
    create: () => {
      created++
      return createPicker()
    },
  },
}))

const { Service, fffLayer } = await import("@opencode-ai/core/filesystem/search")

const ripgrep = Ripgrep.Service.of({
  find: () => Effect.succeed([]),
  glob: () =>
    Effect.succeed([
      Entry.make({
        path: RelativePath.make("fallback.txt"),
        type: "file",
      }),
    ]),
  grep: () => Effect.succeed([]),
})

function searchLayer(directory: string) {
  return fffLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        AppNodeBuilder.build(FSUtil.node),
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        Layer.succeed(Ripgrep.Service, ripgrep),
      ),
    ),
  )
}

function withTmp<A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => run(tmp.path)))
}

beforeEach(() => {
  created = 0
  destroyed = 0
  createPicker = () => ({ ok: true, value: picker() })
})

describe("FileSystemSearch FFF lifecycle", () => {
  it.live("initializes lazily, reuses the picker, and disposes with the location scope", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const search = Context.get(yield* Layer.buildWithScope(Layer.fresh(searchLayer(directory)), scope), Service)

        expect(created).toBe(0)
        const [found, globbed] = yield* Effect.all(
          [search.find({ query: "index", type: "file" }), search.glob({ pattern: "**/*.ts" })],
          { concurrency: 2 },
        )
        expect(found).toHaveLength(1)
        expect(globbed).toHaveLength(1)
        expect(created).toBe(1)
        expect(destroyed).toBe(0)

        yield* Scope.close(scope, Exit.void)
        expect(destroyed).toBe(1)
      }),
    ),
  )

  it.live("keeps the picker alive until an active operation completes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const current = picker()
        createPicker = () => ({
          ok: true,
          value: {
            ...current,
            fileSearch: () => {
              expect(destroyed).toBe(0)
              return {
                ok: true,
                value: {
                  items: [],
                  scores: [],
                  totalMatched: 0,
                  totalFiles: 0,
                },
              }
            },
          },
        })

        const search = Context.get(yield* Layer.buildWithScope(Layer.fresh(searchLayer(directory)), scope), Service)
        expect(yield* search.find({ query: "index", type: "file" })).toEqual([])
        expect(destroyed).toBe(0)

        yield* Scope.close(scope, Exit.void)
        expect(destroyed).toBe(1)
      }),
    ),
  )

  it.effect("disposes the picker after ten idle minutes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const search = Context.get(yield* Layer.buildWithScope(Layer.fresh(searchLayer(directory)), scope), Service)

        yield* search.find({ query: "index", type: "file" })
        yield* TestClock.adjust("9 minutes")
        expect(destroyed).toBe(0)
        yield* TestClock.adjust("1 minute")
        expect(destroyed).toBe(1)

        yield* Scope.close(scope, Exit.void)
      }),
    ),
  )

  it.live("uses ripgrep when FFF initialization fails", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        createPicker = () => ({ ok: false, error: "unavailable" })
        const scope = yield* Scope.make()
        const search = Context.get(yield* Layer.buildWithScope(Layer.fresh(searchLayer(directory)), scope), Service)

        const found = yield* search.glob({ pattern: "*" })
        expect(found.map((entry) => entry.path)).toEqual([RelativePath.make("fallback.txt")])
        expect(created).toBe(1)
        expect(destroyed).toBe(0)

        yield* Scope.close(scope, Exit.void)
      }),
    ),
  )
})
