import { monitorEventLoopDelay } from "node:perf_hooks"
import { Effect } from "effect"

const INTERVAL_MS = 30_000
const NANOSECONDS_PER_MILLISECOND = 1_000_000

type Monitor = Pick<
  ReturnType<typeof monitorEventLoopDelay>,
  "enable" | "disable" | "reset" | "percentile" | "max"
>

type Timer = {
  unref?: () => void
}

type StartInput = {
  readonly monitor?: Monitor
  readonly memoryUsage?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal">
  readonly every?: (run: () => void) => Timer
  readonly clear?: (timer: Timer) => void
}

type Snapshot = {
  readonly eventLoopP95Ms: number
  readonly eventLoopMaxMs: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly heapTotalBytes: number
  readonly liveInstances: number
}

type LiveInstances = {
  readonly update: (value: number) => void
  readonly close: () => void
}

let state: Snapshot = {
  eventLoopP95Ms: 0,
  eventLoopMaxMs: 0,
  rssBytes: 0,
  heapUsedBytes: 0,
  heapTotalBytes: 0,
  liveInstances: 0,
}
let activeStop: (() => void) | undefined
const liveInstanceCounts = new Map<symbol, number>()

export function start(input: StartInput = {}) {
  if (activeStop) return activeStop

  const monitor = input.monitor ?? monitorEventLoopDelay({ resolution: 20 })
  const memoryUsage = input.memoryUsage ?? process.memoryUsage
  const every = input.every ?? ((run: () => void) => setInterval(run, INTERVAL_MS))
  const clear = input.clear ?? ((timer: Timer) => clearInterval(timer as ReturnType<typeof setInterval>))
  monitor.enable()
  const sample = () => {
    const memory = memoryUsage()
    state = {
      eventLoopP95Ms: monitor.percentile(95) / NANOSECONDS_PER_MILLISECOND,
      eventLoopMaxMs: monitor.max / NANOSECONDS_PER_MILLISECOND,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      liveInstances: state.liveInstances,
    }
    monitor.reset()
  }
  sample()
  const timer = every(sample)
  timer.unref?.()

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clear(timer)
    monitor.disable()
    if (activeStop === stop) activeStop = undefined
  }
  activeStop = stop
  return stop
}

export function snapshot() {
  return state
}

export function registerLiveInstances(): LiveInstances {
  const id = Symbol()
  const updateState = () => {
    state = { ...state, liveInstances: liveInstanceCounts.values().reduce((sum, value) => sum + value, 0) }
  }
  liveInstanceCounts.set(id, 0)
  return {
    update(value) {
      if (!liveInstanceCounts.has(id)) return
      liveInstanceCounts.set(id, value)
      updateState()
    },
    close() {
      if (!liveInstanceCounts.delete(id)) return
      updateState()
    },
  }
}

export const annotate = Effect.suspend(() =>
  Effect.annotateCurrentSpan({
    "process.event_loop.p95_ms": state.eventLoopP95Ms,
    "process.event_loop.max_ms": state.eventLoopMaxMs,
    "process.memory.rss_bytes": state.rssBytes,
    "process.memory.heap_used_bytes": state.heapUsedBytes,
    "process.memory.heap_total_bytes": state.heapTotalBytes,
    "process.instances.live": state.liveInstances,
  }),
)

export * as ProcessPressure from "./process-pressure"
