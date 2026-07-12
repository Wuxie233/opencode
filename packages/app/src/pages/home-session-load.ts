const DEFAULT_CONCURRENCY = 6

export async function loadHomeSessions(
  directories: string[],
  load: (directory: string) => Promise<void>,
  concurrency = DEFAULT_CONCURRENCY,
) {
  const queue = directories.values()
  const workers = Math.min(Math.max(1, Math.floor(concurrency)), directories.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (const directory of queue) await load(directory)
    }),
  )
}
