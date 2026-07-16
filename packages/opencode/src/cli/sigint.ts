type Handler = () => boolean

let owner: Handler | undefined

export function register(handler: Handler) {
  owner = handler
  return () => {
    if (owner === handler) owner = undefined
  }
}

export function dispatch() {
  return owner?.() ?? false
}

export * as Sigint from "./sigint"
