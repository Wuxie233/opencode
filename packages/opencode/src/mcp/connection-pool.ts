import path from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  ListRootsRequestSchema,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Cause, Context, Data, Effect, Exit, Layer, RcMap, Stream, type Duration, type Scope } from "effect"
import { McpCatalog } from "./catalog"
import { McpAuth } from "./auth"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { withTimeout } from "@/util/timeout"

const DEFAULT_TIMEOUT = 30_000
const IDLE_TIME_TO_LIVE = "2 hours"
const CLIENT_OPTIONS = {
  capabilities: { roots: {} },
} satisfies ClientOptions

type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

export class Key extends Data.Class<{
  readonly directory: string
  readonly name: string
  readonly fingerprint: string
}> {}

export type Input =
  | { readonly key: Key; readonly config: ConfigMCPV1.Local }
  | { readonly key: Key; readonly config: ConfigMCPV1.Remote }

type Bundle = {
  readonly client: Client
  readonly metadata: Metadata
  readonly processes: readonly ProcessIdentity[]
}

type ProcessIdentity = {
  readonly pid: number
  readonly started: string | undefined
}

export type Metadata = {
  readonly defs: readonly MCPToolDef[]
  readonly instructions: string | undefined
  readonly capabilities: Capabilities
  readonly generation: string
}

export type Capabilities = {
  readonly tools: boolean
  readonly prompts: boolean
  readonly resources: boolean
}

export class ClientRegistrationError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export type Event =
  | { readonly type: "closed"; readonly key: Key; readonly generation: string }
  | {
      readonly type: "tools_changed"
      readonly key: Key
      readonly generation: string
      readonly defs: readonly MCPToolDef[]
    }
  | {
      readonly type: "log"
      readonly key: Key
      readonly generation: string
      readonly params: LoggingMessageNotification["params"]
    }

type Generation = {
  readonly id: string
  readonly logical: string
  readonly input: Input
  ready: Client | undefined
}

export const input = (directory: string, name: string, config: ConfigMCPV1.Info): Input => {
  const key = new Key({ directory, name, fingerprint: fingerprint(config) })
  if (config.type === "local") return { key, config }
  return { key, config }
}

export interface Interface {
  readonly open: (input: Input) => Effect.Effect<Metadata, Error>
  readonly use: <A, E, R>(input: Input, f: (client: Client) => Effect.Effect<A, E, R>) => Effect.Effect<A, Error | E, R>
  readonly invalidate: (key: Key) => Effect.Effect<void>
  readonly startAuth: (input: Input) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, Error>
  readonly finishAuth: (input: Input, authorizationCode: string) => Effect.Effect<void, Error>
  readonly cancelAuth: (key: Key) => Effect.Effect<void>
  readonly cancelAuthForDirectory: (directory: string) => Effect.Effect<void>
  readonly subscribe: (listener: (event: Event) => void) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpConnectionPool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const current = new Map<string, Generation>()
    const generations = new Map<string, Generation>()
    const pendingAuth = new Map<
      string,
      {
        readonly key: Key
        readonly client: Client
        readonly transport: StreamableHTTPClientTransport
        readonly provider: McpOAuthPendingProvider
      }
    >()
    const listeners = new Set<(event: Event) => void>()
    const emit = (event: Event) => listeners.forEach((listener) => listener(event))
    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const token of text.split("\n")) {
            const child = Number.parseInt(token, 10)
            if (Number.isNaN(child) || pids.includes(child)) continue
            pids.push(child)
            queue.push(child)
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )
    const terminate = Effect.fnUntraced(function* (processes: readonly ProcessIdentity[]) {
      const parent = processes[0]
      const currentParent = parent === undefined ? undefined : yield* processIdentity(parent.pid)
      const discovered =
        parent !== undefined && currentParent?.started === parent.started ? yield* descendants(parent.pid) : []
      const known = new Map(processes.map((entry) => [entry.pid, entry]))
      const pids = [
        ...new Set([
          ...discovered.reverse(),
          ...processes
            .slice(1)
            .map((entry) => entry.pid)
            .reverse(),
          parent?.pid,
        ]),
      ]
      for (const pid of pids) {
        if (pid === undefined) continue
        const expected = known.get(pid)
        if (expected?.started !== undefined && (yield* processIdentity(pid))?.started !== expected.started) continue
        yield* Effect.try({ try: () => process.kill(pid, "SIGTERM"), catch: () => undefined }).pipe(Effect.ignore)
      }
    })
    const closeReady = (generation: Generation) =>
      Effect.suspend(() => {
        const client = generation.ready
        generation.ready = undefined
        if (!client) return Effect.void
        return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      })
    let connections: RcMap.RcMap<string, Bundle, Error>
    connections = yield* RcMap.make<string, Bundle, Error, Scope.Scope>({
      idleTimeToLive: IDLE_TIME_TO_LIVE,
      lookup: (generationID) =>
        Effect.gen(function* () {
          const generation = generations.get(generationID)
          if (!generation) return yield* Effect.fail(new Error("Missing MCP connection generation"))
          const ready = generation.ready
          generation.ready = undefined
          const connected = yield* ready
            ? makeBundle(ready, generation.input.config.timeout, generation.id)
            : connect(generation.input, auth, generation.id, descendants)
          connected.client.onclose = () => {
            if (current.get(generation.logical)?.id === generation.id) current.delete(generation.logical)
            emit({ type: "closed", key: generation.input.key, generation: generation.id })
            void Effect.runPromise(RcMap.invalidate(connections, generation.id))
          }
          connected.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
            emit({ type: "log", key: generation.input.key, generation: generation.id, params: notification.params })
          })
          if (connected.metadata.capabilities.tools) {
            connected.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
              const defs = await Effect.runPromise(McpCatalog.defs(connected.client, generation.input.config.timeout))
              if (defs) emit({ type: "tools_changed", key: generation.input.key, generation: generation.id, defs })
            })
          }
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              generations.delete(generation.id)
              if (current.get(generation.logical)?.id === generation.id) current.delete(generation.logical)
              yield* terminate(connected.processes)
              yield* Effect.tryPromise(() => connected.client.close()).pipe(Effect.ignore)
            }),
          )
          return connected
        }),
    })
    const detach = Effect.fnUntraced(function* (generation: Generation) {
      if (current.get(generation.logical)?.id === generation.id) current.delete(generation.logical)
      yield* closeReady(generation)
      yield* RcMap.invalidate(connections, generation.id)
    })
    const replace = Effect.fnUntraced(function* (next: Input, ready?: Client) {
      const logical = planKey(next.key)
      const previous = current.get(logical)
      if (previous) yield* detach(previous)
      const generation: Generation = { id: crypto.randomUUID(), logical, input: next, ready }
      current.set(logical, generation)
      generations.set(generation.id, generation)
      return generation
    })
    const get = Effect.fn("McpConnectionPool.get")(function* (next: Input) {
      const logical = planKey(next.key)
      const generation = current.get(logical) ?? (yield* replace(next))
      return yield* RcMap.get(connections, generation.id)
    })
    const open = Effect.fn("McpConnectionPool.open")(function* (next: Input) {
      return (yield* Effect.scoped(get(next))).metadata
    })
    const use = Effect.fn("McpConnectionPool.use")(function* <A, E, R>(
      next: Input,
      f: (client: Client) => Effect.Effect<A, E, R>,
    ) {
      return yield* Effect.scoped(Effect.flatMap(get(next), (connected) => f(connected.client)))
    })
    const invalidate = Effect.fn("McpConnectionPool.invalidate")(function* (key: Key) {
      const generation = current.get(planKey(key))
      if (generation) yield* detach(generation)
    })
    const startAuth = Effect.fn("McpConnectionPool.startAuth")(function* (next: Input) {
      if (!isRemote(next) || next.config.oauth === false)
        return yield* Effect.fail(new Error(`MCP server ${next.key.name} does not support OAuth`))
      const url = URL.canParse(next.config.url) ? new URL(next.config.url) : undefined
      if (!url) return yield* Effect.fail(new Error(`Invalid MCP URL for "${next.key.name}"`))
      const oauth = typeof next.config.oauth === "object" ? next.config.oauth : undefined
      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateFlowOAuthState(oauthKey(next.key), oauthState)
      let authorizationUrl: URL | undefined
      const provider = new McpOAuthPendingProvider(
        next.key.name,
        next.config.url,
        {
          clientId: oauth?.clientId,
          clientSecret: oauth?.clientSecret,
          scope: oauth?.scope,
          redirectUri:
            oauth?.redirectUri ??
            (oauth?.callbackPort ? `http://127.0.0.1:${oauth.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined),
        },
        {
          onRedirect: async (url) => {
            authorizationUrl = url
          },
        },
        auth,
        oauthKey(next.key),
      )
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider: provider,
        requestInit: { headers: { ...next.config.headers, "x-opencode-directory": next.key.directory } },
      })
      const client = createClient(next.key.directory)
      const result = yield* Effect.tryPromise({
        try: async () => {
          await client.connect(transport)
          await provider.commit()
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.exit)
      if (Exit.isSuccess(result)) {
        yield* replace(next, client)
        return { authorizationUrl: "", oauthState }
      }
      const error = Cause.squash(result.cause)
      if (error instanceof UnauthorizedError && authorizationUrl) {
        const previous = pendingAuth.get(planKey(next.key))
        if (previous) yield* Effect.tryPromise(() => previous.client.close()).pipe(Effect.ignore)
        pendingAuth.set(planKey(next.key), { key: next.key, client, transport, provider })
        return { authorizationUrl: authorizationUrl.toString(), oauthState }
      }
      yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      yield* Effect.tryPromise(() => transport.close()).pipe(Effect.ignore)
      return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
    })
    const finishAuth = Effect.fn("McpConnectionPool.finishAuth")(function* (next: Input, authorizationCode: string) {
      const pending = pendingAuth.get(planKey(next.key))
      if (!pending) return yield* Effect.fail(new Error(`No pending OAuth flow for MCP server: ${next.key.name}`))
      yield* Effect.tryPromise({
        try: () => pending.transport.finishAuth(authorizationCode),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      yield* Effect.promise(() => pending.provider.commit())
      pendingAuth.delete(planKey(next.key))
      yield* Effect.tryPromise(() => pending.client.close()).pipe(Effect.ignore)
    })
    const cancelAuth = Effect.fn("McpConnectionPool.cancelAuth")(function* (key: Key) {
      const pending = pendingAuth.get(planKey(key))
      pendingAuth.delete(planKey(key))
      if (pending) yield* Effect.tryPromise(() => pending.client.close()).pipe(Effect.ignore)
      const generation = current.get(planKey(key))
      if (generation) yield* detach(generation)
    })
    const cancelAuthForDirectory = Effect.fn("McpConnectionPool.cancelAuthForDirectory")(function* (directory: string) {
      const pending = [...pendingAuth.values()].filter((entry) => entry.key.directory === directory)
      for (const entry of pending) {
        pendingAuth.delete(planKey(entry.key))
        yield* Effect.tryPromise(() => entry.client.close()).pipe(Effect.ignore)
      }
    })
    const subscribe = Effect.fn("McpConnectionPool.subscribe")(function* (listener: (event: Event) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...pendingAuth.values()],
        (entry) => Effect.tryPromise(() => entry.client.close()).pipe(Effect.ignore),
        {
          discard: true,
        },
      ).pipe(
        Effect.andThen(Effect.forEach([...generations.values()], closeReady, { discard: true })),
        Effect.andThen(
          Effect.sync(() => {
            pendingAuth.clear()
            current.clear()
            generations.clear()
          }),
        ),
      ),
    )
    return Service.of({ open, use, invalidate, startAuth, finishAuth, cancelAuth, cancelAuthForDirectory, subscribe })
  }),
)

function planKey(key: Key) {
  return `${key.directory}\u0000${key.name}\u0000${key.fingerprint}`
}

function oauthKey(key: Key) {
  return `${key.directory}\u0000${key.name}`
}

function fingerprint(config: ConfigMCPV1.Info) {
  return createHash("sha256").update(stableJson(config)).digest("hex")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function createClient(directory: string) {
  const client = new Client({ name: "opencode", version: InstallationVersion }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

function connect(
  input: Input,
  auth: McpAuth.Interface,
  generation: string,
  descendants: (pid: number) => Effect.Effect<number[]>,
): Effect.Effect<Bundle, Error, Scope.Scope> {
  if (isLocal(input)) return connectLocal(input, generation, descendants)
  return connectRemote(input, auth, generation)
}

function isLocal(input: Input): input is Extract<Input, { readonly config: ConfigMCPV1.Local }> {
  return input.config.type === "local"
}

function isRemote(input: Input): input is Extract<Input, { readonly config: ConfigMCPV1.Remote }> {
  return input.config.type === "remote"
}

function connectLocal(
  input: Extract<Input, { readonly config: ConfigMCPV1.Local }>,
  generation: string,
  descendants: (pid: number) => Effect.Effect<number[]>,
): Effect.Effect<Bundle, Error, Scope.Scope> {
  const [command, ...args] = input.config.command
  const cwd = input.config.cwd ? path.resolve(input.key.directory, input.config.cwd) : input.key.directory
  const transport = new StdioClientTransport({
    stderr: "pipe",
    command,
    args,
    cwd,
    env: { ...process.env, ...(command === "opencode" ? { BUN_BE_BUN: "1" } : {}), ...input.config.environment },
  })
  return connectTransport(input.key.directory, transport, input.config.timeout ?? DEFAULT_TIMEOUT, (current) =>
    Effect.gen(function* () {
      const pid = current instanceof StdioClientTransport ? current.pid : undefined
      const children = typeof pid === "number" ? yield* descendants(pid) : []
      for (const child of children.reverse()) {
        yield* Effect.try({ try: () => process.kill(child, "SIGTERM"), catch: () => undefined }).pipe(Effect.ignore)
      }
      if (typeof pid === "number") {
        yield* Effect.try({ try: () => process.kill(pid, "SIGTERM"), catch: () => undefined }).pipe(Effect.ignore)
      }
      yield* Effect.tryPromise(() => current.close()).pipe(Effect.ignore)
    }),
  ).pipe(
    Effect.flatMap((client) =>
      Effect.gen(function* () {
        const pid = transport.pid
        const processes =
          typeof pid === "number"
            ? (yield* Effect.all([pid, ...(yield* descendants(pid))].map(processIdentity))).filter(
                (entry): entry is ProcessIdentity => entry !== undefined,
              )
            : []
        return yield* makeBundle(client, input.config.timeout, generation, processes)
      }),
    ),
  )
}

function connectRemote(
  input: Extract<Input, { readonly config: ConfigMCPV1.Remote }>,
  auth: McpAuth.Interface,
  generation: string,
): Effect.Effect<Bundle, Error, Scope.Scope> {
  const url = URL.canParse(input.config.url) ? new URL(input.config.url) : undefined
  if (!url) return Effect.fail(new Error(`Invalid MCP URL for "${input.key.name}"`))
  const oauth =
    input.config.oauth === false ? undefined : typeof input.config.oauth === "object" ? input.config.oauth : undefined
  const provider =
    input.config.oauth === false
      ? undefined
      : new McpOAuthProvider(
          input.key.name,
          input.config.url,
          {
            clientId: oauth?.clientId,
            clientSecret: oauth?.clientSecret,
            scope: oauth?.scope,
            callbackPort: oauth?.callbackPort,
            redirectUri: oauth?.redirectUri,
          },
          { onRedirect: async () => {} },
          auth,
          oauthKey(input.key),
        )
  const requestInit = { headers: { ...input.config.headers, "x-opencode-directory": input.key.directory } }
  const timeout = input.config.timeout ?? DEFAULT_TIMEOUT
  return connectTransport(
    input.key.directory,
    new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit }),
    timeout,
  ).pipe(
    Effect.catch((error) =>
      isDynamicClientRegistrationError(error)
        ? Effect.fail(new ClientRegistrationError(error.message))
        : error instanceof UnauthorizedError
          ? Effect.fail(error)
          : connectTransport(
              input.key.directory,
              new SSEClientTransport(url, { authProvider: provider, requestInit }),
              timeout,
            ).pipe(
              Effect.catch((fallbackError) =>
                isDynamicClientRegistrationError(fallbackError)
                  ? Effect.fail(new ClientRegistrationError(fallbackError.message))
                  : Effect.fail(fallbackError),
              ),
            ),
    ),
    Effect.flatMap((client) => makeBundle(client, input.config.timeout, generation)),
  )
}

function connectTransport(
  directory: string,
  transport: Transport,
  timeout: number,
  close = (current: Transport) => Effect.tryPromise(() => current.close()).pipe(Effect.ignore),
): Effect.Effect<Client, Error, Scope.Scope> {
  return Effect.acquireUseRelease(
    Effect.succeed(transport),
    (current) =>
      Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return withTimeout(client.connect(current), timeout).then(() => client)
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    (current, exit) => (Exit.isFailure(exit) ? close(current) : Effect.void),
  )
}

function makeBundle(
  client: Client,
  timeout: number | undefined,
  generation: string,
  processes: readonly ProcessIdentity[] = [],
): Effect.Effect<Bundle, Error> {
  return Effect.gen(function* () {
    const capabilities: Capabilities = {
      tools: !!client.getServerCapabilities()?.tools,
      prompts: !!client.getServerCapabilities()?.prompts,
      resources: !!client.getServerCapabilities()?.resources,
    }
    const defs = capabilities.tools ? yield* McpCatalog.defs(client, timeout) : []
    if (!defs) return yield* Effect.fail(new Error("Failed to get MCP tools"))
    return {
      client,
      metadata: { defs, instructions: client.getInstructions()?.trim(), capabilities, generation },
      processes,
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.tryPromise(() => client.close()).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
    ),
  )
}

function processIdentity(pid: number): Effect.Effect<ProcessIdentity | undefined> {
  if (process.platform !== "linux") return Effect.succeed({ pid, started: undefined })
  return Effect.tryPromise(() => Bun.file(`/proc/${pid}/stat`).text()).pipe(
    Effect.option,
    Effect.map((stat) => {
      if (stat._tag === "None") return undefined
      const end = stat.value.lastIndexOf(")")
      return {
        pid,
        started: end < 0 ? undefined : stat.value.slice(end + 2).split(" ")[19],
      }
    }),
  )
}

function isDynamicClientRegistrationError(error: Error) {
  return (
    error instanceof Error && error.message === "Incompatible auth server: does not support dynamic client registration"
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [CrossSpawnSpawner.node, McpAuth.node] })

export interface TestPool<A, E = never> {
  readonly get: (key: string) => Effect.Effect<A, E, Scope.Scope>
  readonly use: <B, E2, R>(key: string, f: (value: A) => Effect.Effect<B, E2, R>) => Effect.Effect<B, E | E2, R>
  readonly invalidate: (key: string) => Effect.Effect<void>
}

export function make<A, E, R>(input: {
  readonly lookup: (key: string) => Effect.Effect<A, E, R>
  readonly idleTimeToLive: Duration.Input
}): Effect.Effect<TestPool<A, E>, never, Scope.Scope | R> {
  return Effect.gen(function* () {
    const current = new Map<string, string>()
    const logical = new Map<string, string>()
    let resources: RcMap.RcMap<string, A, E>
    resources = yield* RcMap.make<string, A, E, R>({
      idleTimeToLive: input.idleTimeToLive,
      lookup: (generation) => {
        const key = logical.get(generation)
        if (key === undefined) return Effect.die(new Error("Missing MCP test generation"))
        return input.lookup(key)
      },
    })
    const get = (key: string) => {
      const generation = current.get(key) ?? crypto.randomUUID()
      current.set(key, generation)
      logical.set(generation, key)
      return RcMap.get(resources, generation)
    }
    return {
      get,
      use: (key, f) => Effect.scoped(Effect.flatMap(get(key), f)),
      invalidate: (key) =>
        Effect.gen(function* () {
          const generation = current.get(key)
          if (!generation) return
          current.delete(key)
          yield* RcMap.invalidate(resources, generation)
        }),
    } satisfies TestPool<A, E>
  })
}

export * as ConnectionPool from "./connection-pool"
