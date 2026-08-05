type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string, full: boolean) => Promise<void> | void
  wait?: (directory: string) => Promise<void> | undefined
  key?: (directory: string) => string
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, { directory: string; full: boolean }>()
  const active = new Map<
    string,
    {
      item: { directory: string; full: boolean }
      started: boolean
      cancelled: boolean
      next?: { directory: string; full: boolean }
    }
  >()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return []
    const items: { directory: string; full: boolean }[] = []
    for (const [id, item] of queued) {
      queued.delete(id)
      items.push(item)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string, full = true) => {
    if (!directory) return
    const id = key(directory)
    const current = active.get(id)
    if (current) {
      current.cancelled = false
      if (!current.started) {
        current.item = { directory, full: current.item.full || full }
        return
      }
      current.next = { directory, full: (current.next?.full ?? false) || full }
      return
    }
    queued.set(id, { directory, full: (queued.get(id)?.full ?? false) || full })
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (input.paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (input.paused()) return
        if (root) {
          root = false
          await input.bootstrap()
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(
          dirs.map(async (item) => {
            const id = key(item.directory)
            const state = { item, started: false, cancelled: false } as {
              item: { directory: string; full: boolean }
              started: boolean
              cancelled: boolean
              next?: { directory: string; full: boolean }
            }
            active.set(id, state)
            try {
              while (true) {
                const pending = input.wait?.(state.item.directory)
                if (pending) await pending
                if (state.cancelled) return
                state.started = true
                await input.bootstrapInstance(state.item.directory, state.item.full)
                if (state.cancelled) return
                if (!state.next) return
                state.item = state.next
                state.next = undefined
                state.started = false
              }
            } finally {
              active.delete(id)
            }
          }),
        )
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (input.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    recover(directory: string) {
      push(directory, false)
    },
    refresh,
    clear(directory: string) {
      const id = key(directory)
      queued.delete(id)
      const current = active.get(id)
      if (current) {
        current.cancelled = true
        current.next = undefined
      }
    },
    dispose() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}
