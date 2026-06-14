import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createMemo, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { ServerScope } from "@/utils/server-scope"
import { registerWebStateServerResolver } from "@/utils/web-state"
import { usePlatform } from "./platform"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type ServerProjectState = { projects: Record<string, StoredProject[]>; lastProject: Record<string, string> }
const HEALTH_POLL_INTERVAL_MS = 10_000

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!isRecord(value)) return value
  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const previousProjects = projects?.[canonicalLocalServer]
  const previousLastProject = lastProject?.[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string") return value

  const next = { ...value }
  if (projects && Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) => (isRecord(project) && typeof project.worktree === "string" ? [project.worktree] : [])),
    )
    const migrated = previousProjects.filter((project) => {
      if (!isRecord(project) || typeof project.worktree !== "string") return true
      if (worktrees.has(project.worktree)) return false
      worktrees.add(project.worktree)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (lastProject && typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  return next
}

export function migrateServerListState(value: unknown) {
  if (!isRecord(value)) return value
  return { list: Array.isArray(value.list) ? value.list : [] }
}

export function migrateServerProjectsState(value: unknown, canonicalLocalServer?: ServerConnection.Key): ServerProjectState {
  const migrated = migrateCanonicalLocalServerState(value, canonicalLocalServer)
  if (!isRecord(migrated)) return { projects: {}, lastProject: {} }
  return {
    projects: isRecord(migrated.projects) ? (migrated.projects as Record<string, StoredProject[]>) : {},
    lastProject: isRecord(migrated.lastProject) ? (migrated.lastProject as Record<string, string>) : {},
  }
}

function authHeaders(conn: ServerConnection.Any) {
  if (!conn.http.password) return
  return {
    authorization: `Basic ${btoa(`${conn.http.username ?? "opencode"}:${conn.http.password}`)}`,
  }
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const current = () => input.store.projects[input.scope()] ?? []
  return {
    list: current,
    open(directory: string) {
      const scope = input.scope()
      if (current().some((project) => project.worktree === directory)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
    },
    close(directory: string) {
      setStore(
        "projects",
        input.scope(),
        current().filter((project) => project.worktree !== directory),
      )
    },
    expand(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => project.worktree === directory)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const value of input.stored) {
    const conn: ServerConnection.Http =
      typeof value === "string"
        ? {
            type: "http" as const,
            http: { url: value },
          }
        : "http" in value
          ? value
          : { type: "http", http: value }
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const platform = usePlatform()
    const [state, setState] = createStore({
      active: props.defaultServer,
    })
    let storedServers: Store<{ list: StoredServer[] }> | undefined
    const resolvedServers = () => resolveServerList({ stored: storedServers?.list ?? [], props: props.servers })
    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const unregisterResolver = registerWebStateServerResolver((targetScope) => {
      const conn = resolvedServers().find((item) => scope(ServerConnection.key(item)) === targetScope)
      if (!conn) return
      return {
        url: conn.http.url,
        fetch: platform.fetch ?? globalThis.fetch,
        headers: authHeaders(conn),
      }
    })
    onCleanup(unregisterResolver)

    const [projectStore, setProjectStore, , projectsReady] = persisted(
      {
        ...Persist.serverGlobal(scope(), "server.projects", ["server.v3"]),
        migrate: (value) => migrateServerProjectsState(value, props.canonicalLocalServer),
      },
      createStore({
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: migrateServerListState,
      },
      createStore({
        list: [] as StoredServer[],
      }),
    )
    storedServers = store

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => resolvedServers())

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
    }

    const isReady = createMemo(() => ready() && projectsReady() && !!state.active)

    const projects = createServerProjects({ scope, store: projectStore, setStore: setProjectStore })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store: projectStore, setStore: setProjectStore })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
