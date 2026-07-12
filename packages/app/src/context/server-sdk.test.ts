import { describe, expect, test } from "bun:test"
import {
  coalesceServerEvents,
  createReconnectWait,
  createServerConnectionTracker,
  enqueueServerEvent,
  resumeStreamAfterPageShow,
  runServerReconnectLoop,
  serverConnectionStable,
  serverEventStreamOptions,
  serverReconnectDelay,
} from "./server-sdk"
import type { Event } from "@opencode-ai/sdk/v2/client"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("serverReconnectDelay", () => {
  test("lets the outer reconnect loop own SSE retries", () => {
    expect(serverEventStreamOptions).toEqual({ sseMaxRetryAttempts: 1 })
  })

  test("keeps the first retry at the existing delay", () => {
    expect(serverReconnectDelay(0, () => 0)).toBe(250)
    expect(serverReconnectDelay(0, () => 1)).toBe(250)
  })

  test("backs off repeated failures with bounded jitter", () => {
    expect(serverReconnectDelay(1, () => 0)).toBe(250)
    expect(serverReconnectDelay(1, () => 1)).toBe(500)
    expect(serverReconnectDelay(2, () => 0)).toBe(500)
    expect(serverReconnectDelay(2, () => 1)).toBe(1_000)
    expect(serverReconnectDelay(20, () => 0)).toBe(5_000)
    expect(serverReconnectDelay(20, () => 1)).toBe(10_000)
  })
})

test("a connection must survive the handshake window before it resets backoff", () => {
  expect(serverConnectionStable(undefined, 5_000)).toBe(false)
  expect(serverConnectionStable(1_000, 5_999)).toBe(false)
  expect(serverConnectionStable(1_000, 6_000)).toBe(true)
})

test("connection stability starts at the first SSE event instead of generator creation", () => {
  let now = 10_000
  const connection = createServerConnectionTracker(() => now)

  now = 20_000
  expect(connection.stable()).toBe(false)
  connection.event()
  now = 24_999
  expect(connection.stable()).toBe(false)
  now = 25_000
  expect(connection.stable()).toBe(true)
})

describe("runServerReconnectLoop", () => {
  test("backs off unstable streams and resets only after a stable stream", async () => {
    const stable = [false, false, true, false]
    const delays: number[] = []
    let active = true

    await runServerReconnectLoop({
      active: () => active,
      connect: async () => stable.shift() ?? false,
      wait: async (ms) => {
        delays.push(ms)
        if (delays.length === 4) active = false
      },
      random: () => 1,
    })

    expect(delays).toEqual([250, 500, 250, 250])
  })

  test("does not schedule another retry after the stream is stopped", async () => {
    let active = true
    const delays: number[] = []

    await runServerReconnectLoop({
      active: () => active,
      connect: async () => {
        active = false
        return false
      },
      wait: async (ms) => {
        delays.push(ms)
      },
    })

    expect(delays).toEqual([])
  })
})

test("reconnect waits can be released by visibility and stop signals", async () => {
  const reconnect = createReconnectWait()
  const first = reconnect.wait(60_000)
  reconnect.wake()
  await first

  const second = reconnect.wait(60_000)
  reconnect.wake()
  await second
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
