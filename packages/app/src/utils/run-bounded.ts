export async function runBounded<T>(
  items: T[],
  run: (item: T) => Promise<void>,
  options: { concurrency: number; signal?: AbortSignal },
) {
  const queue = items.values()
  const workers = Math.min(Math.max(1, Math.floor(options.concurrency)), items.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (!options.signal?.aborted) {
        const item = queue.next()
        if (item.done) return
        await run(item.value)
      }
    }),
  )
}
