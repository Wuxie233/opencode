import type { PluginRouteHandler, PluginRouteRegistrar } from "@opencode-ai/plugin"

export const PREFIX = "/api/plugin/"

// Routes are scoped by the owning instance directory. A plugin loaded for two
// directories registers two distinct per-instance handler closures, so the same
// pluginID + method + path must resolve to the handler for the routed instance,
// never the last one registered globally.
const state = new Map<string, Map<string, PluginRouteHandler>>()

function normalizePath(path: string) {
  if (!path.startsWith("/")) return "/" + path
  return path
}

function key(pluginID: string, method: string, path: string) {
  return `${method.toUpperCase()} ${pluginID}\u0000${normalizePath(path)}`
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function register(
  scope: string,
  pluginID: string,
  method: string,
  path: string,
  handler: PluginRouteHandler,
) {
  const routes = state.get(scope) ?? new Map<string, PluginRouteHandler>()
  routes.set(key(pluginID, method, path), handler)
  state.set(scope, routes)
}

export function registrar(scope: string, pluginID: string): PluginRouteRegistrar {
  return {
    register(method, path, handler) {
      register(scope, pluginID, method, path, handler)
    },
  }
}

export function lookup(scope: string, pluginID: string, method: string, path: string) {
  return state.get(scope)?.get(key(pluginID, method, path))
}

export function parse(pathname: string) {
  if (!pathname.startsWith(PREFIX)) return
  const rest = pathname.slice(PREFIX.length)
  if (!rest) return
  const slash = rest.indexOf("/")
  if (slash === -1) return { pluginID: decode(rest), path: "/" }
  const pluginID = rest.slice(0, slash)
  if (!pluginID) return
  return { pluginID: decode(pluginID), path: rest.slice(slash) }
}

export function reset() {
  state.clear()
}

export * as PluginRoute from "./route"
