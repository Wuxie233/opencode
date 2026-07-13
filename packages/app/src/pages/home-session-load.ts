const DEFAULT_CONCURRENCY = 6

export async function loadHomeSessions(
  directories: string[],
  load: (directory: string) => Promise<void>,
  options?: { concurrency?: number; signal?: AbortSignal },
) {
  const queue = directories.values()
  const workers = Math.min(Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_CONCURRENCY)), directories.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (const directory of queue) {
        if (options?.signal?.aborted) return
        await load(directory)
      }
    }),
  )
}
