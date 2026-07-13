import type { ServerConnection } from "@/context/server"
import type { ServerHealth } from "@/utils/server-health"

const SERVER_PREVIEW_DELAY_MS = 300

export function createServerPreview(
  checkServerHealth: (http: ServerConnection.HttpBase, signal: AbortSignal) => Promise<ServerHealth>,
  delayMs = SERVER_PREVIEW_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let generation = 0

  const stop = () => {
    generation += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }

  const run = (http: ServerConnection.HttpBase, setStatus: (value: boolean) => void) => {
    stop()
    const current = generation
    timer = setTimeout(() => {
      timer = undefined
      const request = new AbortController()
      controller = request
      void checkServerHealth(http, request.signal)
        .then((result) => {
          if (current !== generation || request.signal.aborted) return
          setStatus(result.healthy)
        })
        .catch(() => undefined)
        .finally(() => {
          if (controller === request) controller = undefined
        })
    }, delayMs)
  }

  return { run, stop }
}
