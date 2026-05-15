import { describe, expect, test } from "bun:test"
import { createSidebarSyncClient } from "./api-client"

const stateEnvelope = {
  namespace: "personal",
  scope: "local",
  version: 1,
  updatedAt: "2026-05-16T00:00:00.000Z",
  updatedByDeviceId: "device-1",
  payload: { schemaVersion: 1 as const, projects: [{ worktree: "/repo", expanded: true }] },
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("sidebar sync api client", () => {
  test("normalizes base URL by trimming trailing slashes", async () => {
    const requests: string[] = []
    const client = createSidebarSyncClient({
      baseUrl: "https://sync.example.test///",
      fetch: async (input) => {
        requests.push(String(input))
        return jsonResponse({ code: "123456", expiresAt: "2026-05-16T00:00:00.000Z" })
      },
    })

    await client.createPairing({ label: "browser" })

    expect(requests).toEqual(["https://sync.example.test/sidebar-sync/pairing"])
  })

  test("does not attach Authorization to unauthenticated pairing endpoints", async () => {
    const headers: string[] = []
    const client = createSidebarSyncClient({
      baseUrl: "https://sync.example.test",
      token: "secret-token",
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers).get("authorization") ?? "")
        return jsonResponse({ deviceId: "device-1", token: "device-token" })
      },
    })

    await client.claimPairing("PAIR CODE", { deviceName: "laptop" })

    expect(headers).toEqual([""])
  })

  test("attaches Authorization to authed state GET and PUT", async () => {
    const requests: { readonly url: string; readonly method: string; readonly authorization: string | null }[] = []
    const client = createSidebarSyncClient({
      baseUrl: "https://sync.example.test",
      token: "device-token",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
        })
        return jsonResponse(stateEnvelope)
      },
    })

    await client.getState("personal", "local")
    await client.putState("personal", "local", { baseVersion: 1, payload: stateEnvelope.payload })

    expect(requests).toEqual([
      {
        url: "https://sync.example.test/sidebar-sync/state/personal/local",
        method: "GET",
        authorization: "Bearer device-token",
      },
      {
        url: "https://sync.example.test/sidebar-sync/state/personal/local",
        method: "PUT",
        authorization: "Bearer device-token",
      },
    ])
  })

  test("returns undefined for GET 204", async () => {
    const client = createSidebarSyncClient({
      baseUrl: "https://sync.example.test",
      token: "device-token",
      fetch: async () => new Response(undefined, { status: 204 }),
    })

    expect(await client.getState("personal", "local")).toBeUndefined()
  })

  test("throws sanitized errors without body or token", async () => {
    const client = createSidebarSyncClient({
      baseUrl: "https://sync.example.test",
      token: "secret-token",
      fetch: async () => jsonResponse({ error: "Unauthorized", token: "secret-token", body: "raw payload" }, { status: 401 }),
    })

    await expect(client.getState("personal", "local")).rejects.toThrow("Sidebar sync request failed: GET /sidebar-sync/state/personal/local 401")
    await expect(client.getState("personal", "local")).rejects.not.toThrow("secret-token")
    await expect(client.getState("personal", "local")).rejects.not.toThrow("raw payload")
  })
})
