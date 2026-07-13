import { expect, test } from "bun:test"
import { Effect, Tracer } from "effect"
import { ProcessPressure } from "../../src/observability/process-pressure"

test("samples process pressure without retaining the event loop", () => {
  const monitor = {
    enableCalls: 0,
    disableCalls: 0,
    resetCalls: 0,
    enable(): boolean {
      this.enableCalls++
      return true
    },
    disable(): boolean {
      this.disableCalls++
      return true
    },
    reset() {
      this.resetCalls++
    },
    percentile() {
      return 25_000_000
    },
    max: 75_000_000,
  }
  const timers: Array<{ unrefCalls: number; unref(): void }> = []
  let stopped = 0

  const stop = ProcessPressure.start({
    monitor,
    memoryUsage: () => ({ rss: 2048, heapUsed: 1024, heapTotal: 1536 }),
    every: (run) => {
      const timer = {
        unrefCalls: 0,
        unref() {
          this.unrefCalls++
        },
      }
      timers.push(timer)
      return timer
    },
    clear: () => {
      stopped++
    },
  })

  const liveInstances = ProcessPressure.registerLiveInstances()
  liveInstances.update(3)
  expect(ProcessPressure.snapshot()).toEqual({
    eventLoopP95Ms: 25,
    eventLoopMaxMs: 75,
    rssBytes: 2048,
    heapUsedBytes: 1024,
    heapTotalBytes: 1536,
    liveInstances: 3,
  })
  expect(timers[0]?.unrefCalls).toBe(1)
  expect(monitor.enableCalls).toBe(1)
  expect(monitor.resetCalls).toBe(1)

  const spans: Tracer.NativeSpan[] = []
  Effect.runSync(
    ProcessPressure.annotate.pipe(
      Effect.withSpan("health"),
      Effect.provideService(
        Tracer.Tracer,
        Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          },
        }),
      ),
    ),
  )
  expect(Object.fromEntries(spans[0]?.attributes ?? [])).toMatchObject({
    "process.event_loop.p95_ms": 25,
    "process.event_loop.max_ms": 75,
    "process.memory.rss_bytes": 2048,
    "process.instances.live": 3,
  })

  liveInstances.close()
  stop()
  expect(stopped).toBe(1)
  expect(monitor.disableCalls).toBe(1)
})

test("keeps a replacement sampler active when an old stop is called again", () => {
  const monitor = () => ({
    disableCalls: 0,
    enable: () => true,
    disable() {
      this.disableCalls++
      return true
    },
    reset: () => {},
    percentile: () => 0,
    max: 0,
  })
  const firstMonitor = monitor()
  const first = ProcessPressure.start({
    monitor: firstMonitor,
    memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0 }),
    every: () => ({}),
    clear: () => {},
  })
  first()

  const secondMonitor = monitor()
  const second = ProcessPressure.start({
    monitor: secondMonitor,
    memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0 }),
    every: () => ({}),
    clear: () => {},
  })
  first()

  expect(firstMonitor.disableCalls).toBe(1)
  expect(secondMonitor.disableCalls).toBe(0)
  expect(ProcessPressure.start()).toBe(second)
  second()
})

test("aggregates live instances across independent stores", () => {
  const first = ProcessPressure.registerLiveInstances()
  const second = ProcessPressure.registerLiveInstances()

  first.update(2)
  second.update(3)
  expect(ProcessPressure.snapshot().liveInstances).toBe(5)

  first.close()
  expect(ProcessPressure.snapshot().liveInstances).toBe(3)
  second.close()
  expect(ProcessPressure.snapshot().liveInstances).toBe(0)
})
