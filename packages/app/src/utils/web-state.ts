import type { Platform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"
import type { PersistServerConfig, PersistServerRecord } from "@/utils/persist"
import type { UiStateGroupId } from "@/utils/ui-state-contract"

type MaybePromise<T> = T | Promise<T>
type ServerSource = () => MaybePromise<ServerConnection.HttpBase | undefined>
type DirectorySource = () => MaybePromise<string | undefined>
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const PLUGIN_ID = "opencode.web-state"

function defaultUrl() {
  if (typeof location !== "object") return
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

async function request(input: {
  fetcher: Fetcher
  server: ServerConnection.HttpBase
  directory?: string
  name: string
  method: "GET" | "PUT"
  record?: PersistServerRecord
}) {
  const headers = new Headers()
  headers.set("accept", "application/json")
  if (input.directory) headers.set("x-opencode-directory", input.directory)
  if (input.server.password)
    headers.set("authorization", `Basic ${btoa(`${input.server.username ?? "opencode"}:${input.server.password}`)}`)
  if (input.record) headers.set("content-type", "application/json")

  const response = await input.fetcher(new URL(`/api/plugin/${PLUGIN_ID}/state/${input.name}`, input.server.url), {
    method: input.method,
    headers,
    body: input.record ? JSON.stringify(input.record) : undefined,
  })
  if (!response.ok) throw new Error(`web state ${response.status}`)
  return response.json() as Promise<unknown>
}

function boundFetch(input?: typeof fetch): Fetcher {
  const fetcher = input ?? globalThis.fetch
  return (resource, init) => fetcher.call(globalThis, resource, init)
}

export function webStateServer(
  name: UiStateGroupId,
  input: {
    server: ServerSource
    directory?: DirectorySource
    fetch?: typeof fetch
    now?: () => number
    timeoutMs?: number
  },
): PersistServerConfig {
  const fetcher = boundFetch(input.fetch)
  return {
    name,
    now: input.now,
    timeoutMs: input.timeoutMs,
    transport: {
      get: async (key) => {
        const server = await input.server()
        if (!server) throw new Error("web state server unavailable")
        return request({ fetcher, server, directory: await input.directory?.(), name: key, method: "GET" })
      },
      put: async (key, record) => {
        const server = await input.server()
        if (!server) throw new Error("web state server unavailable")
        return request({ fetcher, server, directory: await input.directory?.(), name: key, method: "PUT", record })
      },
    },
  }
}

export function defaultWebStateServer(name: UiStateGroupId, platform: Pick<Platform, "fetch" | "getDefaultServer">) {
  return webStateServer(name, {
    fetch: platform.fetch,
    server: async () => {
      const key = await platform.getDefaultServer?.()
      if (key && /^https?:\/\//.test(key)) return { url: key }
      const url = defaultUrl()
      return url ? { url } : undefined
    },
  })
}
