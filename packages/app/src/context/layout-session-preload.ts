import { pathKey } from "@/utils/path-key"
import { runBounded } from "@/utils/run-bounded"

const CONCURRENCY = 4

export function preloadLayoutSessions(
  directories: string[],
  load: (directory: string) => Promise<void>,
  signal?: AbortSignal,
) {
  const seen = new Set<string>()
  return runBounded(
    directories.filter((directory) => {
      const key = pathKey(directory)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    load,
    { concurrency: CONCURRENCY, signal },
  )
}
