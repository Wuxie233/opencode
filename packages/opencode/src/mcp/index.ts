import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  type LoggingMessageNotification,
  type CallToolResult,
  CallToolResultSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { NamedError } from "@opencode-ai/core/util/error"
import { OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Cause, Effect, Layer, Context, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { McpBrowser } from "./browser"
import { ClientRegistrationError, ConnectionPool } from "./connection-pool"

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Prompt cache types
type PromptInfo = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<Client["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function oauthCallbackKey(directory: string, name: string) {
  return `${directory}\u0000${name}`
}

function statusForConnectionError(error: Error): Status {
  if (error instanceof UnauthorizedError) return { status: "needs_auth" }
  if (error instanceof ClientRegistrationError) {
    return {
      status: "needs_client_registration",
      error: "Server does not support dynamic client registration. Please provide clientId in config.",
    }
  }
  return { status: "failed", error: error.message }
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCPV1.Info>
  status: Record<string, Status>
  connections: Record<string, ConnectionPool.Input>
  capabilities: Record<string, ConnectionPool.Capabilities>
  generations: Record<string, string>
  defs: Record<string, MCPToolDef[]>
  instructions: Record<string, string>
  pendingAuth: Set<string>
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

/** An MCP tool in its native shape; consumers adapt it to their own tool format. */
export interface McpTool {
  /** Shared cached definition; consumers must copy rather than mutate it. */
  readonly def: MCPToolDef
  readonly clientName: string
  readonly timeout?: number
}

export interface ClientInfo {
  readonly capabilities: ConnectionPool.Capabilities
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, ClientInfo>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, McpTool>>
  readonly callTool: (
    clientName: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { abort?: AbortSignal; timeout?: number },
  ) => Effect.Effect<CallToolResult | undefined, Error>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCPV1.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<Client["getPrompt"]>> | undefined, Error>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<Client["readResource"]>> | undefined, Error>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    const browser = yield* McpBrowser.Service
    const pool = yield* ConnectionPool.Service

    const cfgSvc = yield* Config.Service

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* (ctx) {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          config: {},
          status: {},
          connections: {},
          capabilities: {},
          generations: {},
          defs: {},
          instructions: {},
          pendingAuth: new Set(),
        }

        const off = yield* pool.subscribe((event) => {
          if (event.key.directory !== ctx.directory) return
          const current = s.connections[event.key.name]
          if (
            !current ||
            current.key.fingerprint !== event.key.fingerprint ||
            s.generations[event.key.name] !== event.generation
          )
            return
          if (event.type === "closed") {
            delete s.connections[event.key.name]
            delete s.capabilities[event.key.name]
            delete s.generations[event.key.name]
            delete s.defs[event.key.name]
            delete s.instructions[event.key.name]
            s.status[event.key.name] = { status: "failed", error: "Connection closed" }
            bridge.fork(events.publish(ToolsChanged, { server: event.key.name }).pipe(Effect.ignore))
            return
          }
          if (event.type === "log") {
            bridge.fork(serverLog(event.key.name, event.params).pipe(Effect.ignore))
            return
          }
          s.defs[event.key.name] = [...event.defs]
          bridge.fork(events.publish(ToolsChanged, { server: event.key.name }).pipe(Effect.ignore))
        })

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                yield* Effect.logError("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const connection = ConnectionPool.input(ctx.directory, key, mcp)
              const bundle = yield* pool
                .open(connection)
                .pipe(Effect.catch((error) => Effect.succeed(statusForConnectionError(error))))
              if ("status" in bundle) {
                yield* pool.invalidate(connection.key)
                s.status[key] = bundle
                return
              }
              s.status[key] = { status: "connected" }
              s.connections[key] = connection
              s.capabilities[key] = bundle.capabilities
              s.generations[key] = bundle.generation
              s.defs[key] = [...bundle.defs]
              if (bundle.instructions) s.instructions[key] = bundle.instructions
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            off()
            yield* pool.cancelAuthForDirectory(ctx.directory)
            for (const name of s.pendingAuth) McpOAuthCallback.cancelPending(oauthCallbackKey(ctx.directory, name))
            s.connections = {}
            s.capabilities = {}
            s.generations = {}
            s.defs = {}
            s.instructions = {}
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const connection = s.connections[name]
      delete s.connections[name]
      delete s.capabilities[name]
      delete s.generations[name]
      delete s.defs[name]
      delete s.instructions[name]
      if (!connection) return Effect.void
      return pool.invalidate(connection.key)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      connection: ConnectionPool.Input,
      bundle: ConnectionPool.Metadata,
    ) {
      const previous = s.connections[name]
      if (previous && previous.key.fingerprint !== connection.key.fingerprint) yield* pool.invalidate(previous.key)
      s.status[name] = { status: "connected" }
      s.connections[name] = connection
      s.capabilities[name] = bundle.capabilities
      s.generations[name] = bundle.generation
      s.defs[name] = [...bundle.defs]
      if (bundle.instructions) s.instructions[name] = bundle.instructions
      else delete s.instructions[name]
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      for (const key of Object.keys(s.config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.fromEntries(
        Object.entries(s.capabilities)
          .filter(([name]) => s.status[name]?.status === "connected")
          .map(([name, capabilities]) => [name, { capabilities }]),
      )
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.entries(s.instructions)
        .filter(([name]) => s.status[name]?.status === "connected")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          instructions: item,
          tools: (s.defs[name] ?? []).map((tool) => McpCatalog.toolName(name, tool.name)),
        }))
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      if (mcp.enabled === false) {
        yield* closeClient(s, name)
        s.status[name] = { status: "disabled" }
        return s.status[name]
      }
      const directory = yield* InstanceState.directory
      const connection = ConnectionPool.input(directory, name, mcp)
      const bundle = yield* pool.open(connection).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            status: statusForConnectionError(error),
          }),
        ),
      )
      if ("status" in bundle) {
        yield* pool.invalidate(connection.key)
        yield* closeClient(s, name)
        s.status[name] = bundle.status
        return bundle.status
      }
      return yield* storeClient(s, name, connection, bundle)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      s.config[name] = mcp
      yield* createAndStore(name, mcp)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* createAndStore(name, { ...mcp, enabled: true })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      s.status[name] = { status: "disabled" }
    })

    function requestTimeout(s: State, name: string, configured: McpEntry | undefined, fallback?: number) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout : undefined
      return s.config[name]?.timeout ?? staticTimeout ?? fallback
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, McpTool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      for (const clientName of Object.keys(s.connections)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Effect.logWarning("missing cached tools for connected server", { clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig, defaultTimeout)
        for (const def of listed) {
          result[McpCatalog.toolName(clientName, def.name)] = { def, clientName, timeout }
        }
      }
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
      key?: (item: T) => string,
      targetClientName?: string,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        return yield* Effect.forEach(
          Object.entries(s.connections).filter(
            ([name]) => s.status[name]?.status === "connected" && (!targetClientName || name === targetClientName),
          ),
          ([clientName, connection]) =>
            pool
              .use(connection, (client) =>
                McpCatalog.fetch(
                  clientName,
                  client,
                  (c) => listFn(c, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
                  label,
                  key,
                ),
              )
              .pipe(
                Effect.catch(() => Effect.succeed(undefined)),
                Effect.map((items) => Object.entries(items ?? {})),
              ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resources,
        "resources",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resourceTemplates,
        "resource templates",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: Client, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const connection = s.connections[clientName]
      if (!connection) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      const cfg = yield* cfgSvc.get()
      return yield* pool
        .use(connection, (client) =>
          Effect.tryPromise({
            try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
        )
        .pipe(
          Effect.tapError((error) =>
            Effect.logError(`failed to ${label}`, {
              clientName,
              ...meta,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        )
    })

    const callTool = Effect.fn("MCP.callTool")(function* (
      clientName: string,
      toolName: string,
      args: Record<string, unknown>,
      options: { abort?: AbortSignal; timeout?: number },
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) =>
          client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
            resetTimeoutOnProgress: true,
            signal: options.abort,
            timeout: options.timeout ?? timeout,
            onprogress: () => {},
          }),
        "callTool",
        { toolName },
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))
      const directory = yield* InstanceState.directory
      return yield* pool.startAuth(ConnectionPool.input(directory, mcpName, mcpConfig)).pipe(Effect.orDie)
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const mcpConfig = yield* requireMcpConfig(mcpName)
        return yield* createAndStore(mcpName, { ...mcpConfig, enabled: true })
      }

      const s = yield* InstanceState.get(state)
      const directory = yield* InstanceState.directory
      const callbackKey = oauthCallbackKey(directory, mcpName)
      s.pendingAuth.add(mcpName)
      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, callbackKey)
      void callbackPromise.catch(() => {})
      onAuthorization?.(result.authorizationUrl)

      const opened = yield* browser
        .open(result.authorizationUrl)
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
      if (!opened) {
        s.pendingAuth.delete(mcpName)
        McpOAuthCallback.cancelPending(callbackKey)
        const mcpConfig = yield* requireMcpConfig(mcpName)
        yield* pool.cancelAuth(ConnectionPool.input(directory, mcpName, mcpConfig).key)
        yield* events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        return { status: "failed", error: "Failed to open browser for OAuth authorization" } satisfies Status
      }

      const code = yield* Effect.promise(() => callbackPromise).pipe(
        Effect.ensuring(Effect.sync(() => s.pendingAuth.delete(mcpName))),
      )

      const storedState = yield* auth.getFlowOAuthState(oauthCallbackKey(directory, mcpName))
      if (storedState !== result.oauthState) {
        yield* auth.clearFlowOAuthState(oauthCallbackKey(directory, mcpName))
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearFlowOAuthState(oauthCallbackKey(directory, mcpName))
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      const directory = yield* InstanceState.directory
      const connection = ConnectionPool.input(directory, mcpName, mcpConfig)
      const result = yield* pool.finishAuth(connection, authorizationCode).pipe(Effect.exit)
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause)
        return {
          status: "failed",
          error: `OAuth completion failed: ${error instanceof Error ? error.message : String(error)}`,
        } satisfies Status
      }
      yield* auth.clearFlowCodeVerifier(oauthCallbackKey(directory, mcpName))
      return yield* createAndStore(mcpName, { ...mcpConfig, enabled: true })
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      const s = yield* InstanceState.get(state)
      const directory = yield* InstanceState.directory
      yield* auth.remove(mcpName)
      s.pendingAuth.delete(mcpName)
      McpOAuthCallback.cancelPending(oauthCallbackKey(directory, mcpName))
      if (mcpConfig) {
        yield* pool.cancelAuth(ConnectionPool.input(directory, mcpName, mcpConfig).key)
      }
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const runtimeConfig = (yield* InstanceState.has(state))
        ? (yield* InstanceState.get(state)).config[mcpName]
        : undefined
      const mcpConfig = runtimeConfig ?? (yield* cfgSvc.get()).mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const entry = yield* auth.getForUrl(mcpName, mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      callTool,
      prompts,
      resources,
      resourceTemplates,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export const node = makeLocationNode({
  service: Service,
  layer: layer,
  deps: [McpAuth.node, ConnectionPool.node, EventV2Bridge.node, Config.node, McpBrowser.node],
})

export * as MCP from "."
