import { runBounded } from "@/utils/run-bounded"

export type CommandPaletteSessionEntry = {
  id: string
  type: "session"
  title: string
  description: string
  category: string
  directory: string
  sessionID: string
  archived?: number
  updated?: number
}

type Session = {
  id: string
  title?: string
  time?: { archived?: number; updated?: number }
}

export function createSessionEntries(props: {
  workspaces: () => string[]
  label: (directory: string) => string
  load: (directory: string, signal: AbortSignal) => Promise<{ data?: Session[] }>
  untitled: () => string
  category: () => string
}) {
  const state: {
    token: number
    abort: AbortController | undefined
    inflight: Promise<CommandPaletteSessionEntry[]> | undefined
    cached: CommandPaletteSessionEntry[] | undefined
  } = { token: 0, abort: undefined, inflight: undefined, cached: undefined }

  return (text: string) => {
    if (!text.trim()) {
      state.token += 1
      state.abort?.abort()
      state.abort = undefined
      state.inflight = undefined
      state.cached = undefined
      return [] as CommandPaletteSessionEntry[]
    }
    if (state.cached) return state.cached
    if (state.inflight) return state.inflight

    const current = state.token
    const directories = props.workspaces()
    if (directories.length === 0) return [] as CommandPaletteSessionEntry[]
    const abort = new AbortController()
    state.abort = abort
    const results: CommandPaletteSessionEntry[][] = Array.from({ length: directories.length }, () => [])

    const inflight = runBounded(
      directories.map((directory, index) => ({ directory, index })),
      async ({ directory, index }) => {
        const description = props.label(directory)
        results[index] = await props
          .load(directory, abort.signal)
          .then((result) =>
            (result.data ?? [])
              .filter((session) => !!session?.id)
              .map((session) => ({
                id: `session:${directory}:${session.id}`,
                type: "session" as const,
                title: session.title ?? props.untitled(),
                description,
                category: props.category(),
                directory,
                sessionID: session.id,
                archived: session.time?.archived,
                updated: session.time?.updated,
              })),
          )
          .catch(() => [])
      },
      { concurrency: 4, signal: abort.signal },
    )
      .then(() => {
        if (state.token !== current) return [] as CommandPaletteSessionEntry[]
        const seen = new Set<string>()
        const next = results.flat().filter((item) => {
          const key = `${item.directory}:${item.sessionID}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        state.cached = next
        return next
      })
      .catch(() => [] as CommandPaletteSessionEntry[])
      .finally(() => {
        if (state.abort === abort) state.abort = undefined
        if (state.inflight === inflight) state.inflight = undefined
      })

    state.inflight = inflight
    return inflight
  }
}
