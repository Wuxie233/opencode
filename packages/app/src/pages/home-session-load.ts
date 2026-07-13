import { runBounded } from "@/utils/run-bounded"

const DEFAULT_CONCURRENCY = 6

export async function loadHomeSessions(
  directories: string[],
  load: (directory: string) => Promise<void>,
  options?: { concurrency?: number; signal?: AbortSignal },
) {
  return runBounded(directories, load, {
    concurrency: options?.concurrency ?? DEFAULT_CONCURRENCY,
    signal: options?.signal,
  })
}
