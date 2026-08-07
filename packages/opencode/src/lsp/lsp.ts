import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, RcMap, Schema, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@opencode-ai/schema/lsp-event"
import { Filesystem } from "@/util/filesystem"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

type LocInput = { file: string; line: number; character: number }

interface State {
  servers: Record<string, Server>
  associated: Map<string, Association>
}

interface Server {
  info: LSPServer.Info
  identity: string
}

interface Association {
  key: string
  serverID: string
  root: string
}

interface RegistryInput {
  server: LSPServer.Info
  root: string
  ctx: InstanceContext
}

interface SpawnPermit {
  input: RegistryInput
  borrowers: number
}

type RegistryEntry =
  | { type: "ready"; client: LSPClient.Info }
  | { type: "unavailable" }
  | { type: "unpermitted" }

const CLIENT_IDLE_TTL = "10 minutes"

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service
    const permits = new Map<string, SpawnPermit>()
    const acquisitionLocks = new Map<string, Semaphore.Semaphore>()
    const clients = yield* RcMap.make({
      idleTimeToLive: CLIENT_IDLE_TTL,
      lookup: (key: string) =>
        Effect.acquireRelease(
          Effect.promise(async () => {
            const input = permits.get(key)?.input
            if (!input) return { type: "unpermitted" } as const
            const handle = await input.server.spawn(input.root, input.ctx, flags).catch(() => undefined)
            if (!handle) return { type: "unavailable" } as const
            const client = await LSPClient.create({
              serverID: input.server.id,
              server: handle,
              root: input.root,
              directory: input.ctx.directory,
              instance: input.ctx,
            }).catch(async () => {
              await Process.stop(handle.process)
              return undefined
            })
            if (!client) return { type: "unavailable" } as const
            return { type: "ready", client } as const
          }),
          (entry: RegistryEntry) =>
            entry.type === "ready" ? Effect.promise(() => entry.client.shutdown()) : Effect.void,
        ),
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, Server> = {}

        if (!cfg.lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = {
              info: server,
              identity: stableStringify({
                type: "builtin",
                flags,
                directory: Filesystem.resolve(ctx.directory),
                worktree: Filesystem.resolve(ctx.worktree),
              }),
            }
          }

          if (flags.experimentalLspTy) delete servers.pyright
          else delete servers.ty

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]?.info
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                identity: stableStringify({ type: "configured", flags, item }),
                info: {
                  ...existing,
                  id: name,
                  root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                  extensions: item.extensions ?? existing?.extensions ?? [],
                  spawn: async (root) => ({
                    process: lspspawn(item.command[0], item.command.slice(1), {
                      cwd: root,
                      env: { ...process.env, ...item.env },
                    }),
                    initialization: item.initialization,
                  }),
                },
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.info.id)
              .join(", "),
          })
        }

        const s: State = {
          servers,
          associated: new Map(),
        }

        yield* Effect.addFinalizer(() => Effect.sync(() => s.associated.clear()))

        return s
      }),
    )

    const candidates = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as { key: string; input: RegistryInput; association: Association }[]
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: { key: string; input: RegistryInput; association: Association }[] = []
        for (const server of Object.values(s.servers)) {
          if (server.info.extensions.length && !server.info.extensions.includes(extension)) continue

          const root = await server.info.root(file, ctx)
          if (!root) continue
          const normalizedRoot = Filesystem.resolve(root)
          const key = stableStringify({
            root: normalizedRoot,
            serverID: server.info.id,
            identity: server.identity,
          })
          result.push({
            key,
            input: { server: server.info, root: normalizedRoot, ctx },
            association: { key, serverID: server.info.id, root: normalizedRoot },
          })
        }
        return result
      })
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.scoped(
        Effect.forEach(
          yield* candidates(file),
          (candidate) =>
            Effect.gen(function* () {
              const permit = permits.get(candidate.key)
              if (permit) permit.borrowers++
              else permits.set(candidate.key, { input: candidate.input, borrowers: 1 })
              const acquisitionLock = acquisitionLocks.get(candidate.key) ?? Semaphore.makeUnsafe(1)
              acquisitionLocks.set(candidate.key, acquisitionLock)
              const entry = yield* acquisitionLock.withPermits(1)(
                Effect.gen(function* () {
                  const first = yield* RcMap.get(clients, candidate.key)
                  if (first.type !== "unpermitted") return first
                  yield* RcMap.invalidate(clients, candidate.key)
                  return yield* RcMap.get(clients, candidate.key)
                }),
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    const current = permits.get(candidate.key)
                    if (!current || --current.borrowers > 0) return
                    permits.delete(candidate.key)
                    acquisitionLocks.delete(candidate.key)
                  }),
                ),
              )
              if (entry.type !== "ready") {
                yield* RcMap.invalidate(clients, candidate.key)
                return undefined
              }
              if (!s.associated.has(candidate.association.key)) {
                s.associated.set(candidate.association.key, candidate.association)
                yield* events.publish(Event.Updated, {})
              }
              return yield* Effect.promise(() => fn(entry.client))
            }),
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.map((result) => result.filter((value): value is T => value !== undefined)))
    })

    const runAssociated = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.scoped(
        Effect.forEach(
          Array.from(s.associated.values()),
          (association) =>
            Effect.gen(function* () {
              if (!(yield* RcMap.has(clients, association.key))) {
                s.associated.delete(association.key)
                return undefined
              }
              const entry = yield* RcMap.get(clients, association.key)
              if (entry.type !== "ready") {
                s.associated.delete(association.key)
                yield* RcMap.invalidate(clients, association.key)
                return undefined
              }
              return yield* Effect.promise(() => fn(entry.client))
            }),
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.map((result) => result.filter((value): value is T => value !== undefined)))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const result = yield* runAssociated(async (client) => {
        return {
          id: client.serverID,
          name: client.serverID,
          root: path.relative(ctx.directory, client.root),
          status: "connected" as const,
        }
      })
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.info.extensions.length && !server.info.extensions.includes(extension)) continue
          const root = await server.info.root(file, ctx)
          if (!root) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      yield* run(input, async (client) => {
        const after = Date.now()
        const version = await client.notify.open({ path: input })
        if (!diagnostics) return
        return client.waitForDiagnostics({
          path: input,
          version,
          mode: diagnostics,
          after,
        })
      }).pipe(Effect.catch(() => Effect.void))
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAssociated(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAssociated((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"

function stableStringify(input: unknown): string {
  if (input === undefined) return "undefined"
  if (typeof input === "number" && !Number.isFinite(input)) return String(input)
  if (!input || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`
  return `{${Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`)
    .join(",")}}`
}
