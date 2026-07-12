import { expect, test } from "bun:test"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "../../utils/mock-server"

test("applies message latency after a list response gate is released", async () => {
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: {},
    sessions: [{ id: "session" }],
    messageDelay: 25,
    beforeMessagesResponse: () => {
      events.push("before")
      return gate.promise
    },
    onMessages: (request) => events.push(request.phase),
    pageMessages: () => {
      events.push("page")
      return { items: [] }
    },
  })

  const response = handler!({
    request: () => ({ url: () => "http://127.0.0.1:4096/session/session/message" }),
    fulfill: () => {
      events.push("fulfill")
      return Promise.resolve()
    },
  } as unknown as Route)
  expect(events).toEqual(["start", "before"])

  const released = performance.now()
  gate.resolve()
  await response
  expect(performance.now() - released).toBeGreaterThanOrEqual(20)
  expect(events).toEqual(["start", "before", "page", "end", "fulfill"])
})

test("serves the server-backed web state contract", async () => {
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: {},
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })

  const request = async (method: string, record?: unknown, group = "server.projects", directory?: string) => {
    let response = ""
    let status = 200
    await handler!({
      request: () => ({
        url: () => `http://127.0.0.1:4096/api/plugin/opencode.web-state/state/${group}`,
        method: () => method,
        headers: () => (directory ? { "x-opencode-directory": directory } : {}),
        postDataJSON: () => record,
      }),
      fulfill: (input: { body: string; status: number }) => {
        response = input.body
        status = input.status
        return Promise.resolve()
      },
    } as unknown as Route)
    return { body: JSON.parse(response) as Record<string, unknown>, status }
  }

  expect(await request("GET")).toEqual({
    status: 200,
    body: { value: null, version: "v1", updated_at: 0 },
  })
  expect(await request("PUT", { value: { projects: {} }, version: "v1", updated_at: 10 })).toEqual({
    status: 200,
    body: {
      applied: true,
      value: { projects: {} },
      version: "v1",
      updated_at: 10,
    },
  })
  expect(await request("PUT", { value: { stale: true }, version: "v1", updated_at: 9 })).toEqual({
    status: 200,
    body: {
      applied: false,
      value: { projects: {} },
      version: "v1",
      updated_at: 10,
    },
  })
  expect(await request("GET", undefined, "not-a-group")).toEqual({
    status: 404,
    body: { error: "not_found" },
  })
  expect(await request("PUT", { value: null, version: "v1", updated_at: 11 }, "not-a-group")).toEqual({
    status: 404,
    body: { error: "not_found" },
  })

  await request("PUT", { value: "global", version: "future", updated_at: 20 }, "settings.v3", "/repo-a")
  expect(await request("GET", undefined, "settings.v3", "/repo-b")).toEqual({
    status: 200,
    body: { value: "global", version: "future", updated_at: 20 },
  })

  await request("PUT", { value: "workspace", version: "v1", updated_at: 30 }, "workspace:vcs", "/repo-a")
  expect(await request("GET", undefined, "workspace:vcs", "/repo-b")).toEqual({
    status: 200,
    body: { value: null, version: "v1", updated_at: 0 },
  })
})
