export function createLatestSearch<T>(search: (query: string, signal: AbortSignal) => Promise<T>) {
  let abort: AbortController | undefined
  return {
    run(query: string) {
      abort?.abort()
      const current = new AbortController()
      abort = current
      return search(query, current.signal).finally(() => {
        if (abort === current) abort = undefined
      })
    },
    stop() {
      abort?.abort()
      abort = undefined
    },
  }
}
