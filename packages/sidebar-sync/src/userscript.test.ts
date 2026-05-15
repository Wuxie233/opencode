import { describe, expect, test } from "bun:test"
import { CURRENT_SERVER_STORAGE_KEY } from "./contract"
import {
  CONFIG_STORAGE_KEY,
  createUserscriptFetch,
  saveUserscriptConfig,
  startUserscriptSync,
  type UserscriptDiagnostic,
  USERSCRIPT_VERSION,
} from "./userscript"

function createLocalStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))

  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
    snapshot() {
      return Object.fromEntries(values.entries())
    },
  }
}

function createWindow(seed: Record<string, string> = {}) {
  return {
    localStorage: createLocalStorage(seed),
    location: { protocol: "https:", host: "app.opencode.ai", hostname: "app.opencode.ai", origin: "https://app.opencode.ai" },
    addEventListener() {},
    removeEventListener() {},
  } as {
    localStorage: ReturnType<typeof createLocalStorage>
    location: { readonly protocol: string; readonly host: string; readonly hostname: string; readonly origin: string }
    addEventListener(): void
    removeEventListener(): void
    __OPENCODE_SIDEBAR_SYNC__?: UserscriptDiagnostic
  }
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("userscript fallback adapter", () => {
  test("source includes userscript metadata for supported OpenCode hosts", async () => {
    const source = await Bun.file(new URL("./userscript.ts", import.meta.url)).text()

    expect(source).toContain("// ==UserScript==")
    expect(source).toContain("// @match        https://opencode.wuxie233.com/*")
    expect(source).toContain("// @match        https://app.opencode.ai/*")
    expect(source).toContain("// @match        https://*.dev.opencode.ai/*")
  })

  test("diagnostic object exposes only safe fields", async () => {
    const window = createWindow({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: { "https://app.opencode.ai": [{ worktree: "/repo/raw-secret", expanded: true, token: "raw-token" }] },
        token: "raw-token",
      }),
    })
    const controller = startUserscriptSync({
      config: { baseUrl: "https://sync.example.test", namespace: "personal", token: "secret-token", syncIntervalMs: 50 },
      runtime: {
        window,
        fetch: async () => new Response(undefined, { status: 204 }),
      },
    })

    await Promise.resolve()
    controller.stop()

    expect(Object.keys(window.__OPENCODE_SIDEBAR_SYNC__ ?? {}).sort()).toEqual([
      "baseUrl",
      "enabled",
      "lastError",
      "lastSyncAt",
      "namespace",
      "scope",
      "version",
    ])
    expect(window.__OPENCODE_SIDEBAR_SYNC__).toEqual({
      enabled: true,
      lastError: "GM storage unavailable; using localStorage fallback; GM_xmlhttpRequest unavailable; using fetch fallback",
      lastSyncAt: undefined,
      baseUrl: "https://sync.example.test",
      namespace: "personal",
      scope: "https://app.opencode.ai",
      version: USERSCRIPT_VERSION,
    })
    expect(JSON.stringify(window.__OPENCODE_SIDEBAR_SYNC__)).not.toContain("secret-token")
    expect(JSON.stringify(window.__OPENCODE_SIDEBAR_SYNC__)).not.toContain("raw-token")
    expect(JSON.stringify(window.__OPENCODE_SIDEBAR_SYNC__)).not.toContain("raw-secret")
  })

  test("uploads through shared controller whitelist extraction", async () => {
    const window = createWindow({
      [CURRENT_SERVER_STORAGE_KEY]: JSON.stringify({
        projects: {
          "https://app.opencode.ai": [
            { worktree: "/repo/safe", expanded: true, token: "project-token", list: ["http://localhost:4096"] },
          ],
        },
        lastProject: { "https://app.opencode.ai": "/repo/safe" },
        token: "persisted-token",
        list: ["http://localhost:4096"],
      }),
    })
    const requests: string[] = []
    const controller = startUserscriptSync({
      config: { baseUrl: "https://sync.example.test", namespace: "personal", token: "secret-token", syncIntervalMs: 1 },
      runtime: {
        window,
        fetch: async (input, init) => {
          if (init?.method === "PUT") requests.push(String(init.body))
          return init?.method === "PUT"
            ? jsonResponse({
                namespace: "personal",
                scope: "https://app.opencode.ai",
                version: 1,
                updatedAt: "2026-05-16T00:00:00.000Z",
                updatedByDeviceId: "device-1",
                payload: JSON.parse(String(init.body)).payload,
              })
            : new Response(undefined, { status: 204 })
        },
      },
    })

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("upload was not observed")), 200)
      const poll = setInterval(() => {
        if (requests.length === 0) return
        clearTimeout(deadline)
        clearInterval(poll)
        resolve()
      }, 5)
    })
    controller.stop()

    expect(JSON.parse(requests[0] ?? "{} ")).toEqual({
      baseVersion: 0,
      payload: {
        schemaVersion: 1,
        projects: [{ worktree: "/repo/safe", expanded: true }],
        lastProject: "/repo/safe",
      },
    })
    expect(requests[0] ?? "").not.toContain("project-token")
    expect(requests[0] ?? "").not.toContain("persisted-token")
    expect(requests[0] ?? "").not.toContain("list")
  })

  test("uses GM helpers when available", async () => {
    const stored: Record<string, string> = {}
    const requests: string[] = []
    const fetcher = createUserscriptFetch({
      GM_xmlhttpRequest(details) {
        requests.push(`${details.method} ${details.url} ${details.headers?.authorization ?? ""} ${details.data ?? ""}`)
        details.onload({ status: 200, statusText: "OK", responseText: JSON.stringify({ ok: true }), responseHeaders: "content-type: application/json" })
      },
    })

    saveUserscriptConfig(
      { baseUrl: "https://sync.example.test", namespace: "personal", token: "secret-token" },
      {
        GM_getValue(key) {
          return stored[key] ?? null
        },
        GM_setValue(key, value) {
          stored[key] = value
        },
      },
    )
    await fetcher("https://sync.example.test/sidebar-sync/state/personal/local", {
      method: "PUT",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 0, payload: { schemaVersion: 1, projects: [] } }),
    })

    expect(stored[CONFIG_STORAGE_KEY]).toContain("personal")
    expect(requests).toEqual([
      'PUT https://sync.example.test/sidebar-sync/state/personal/local Bearer secret-token {"baseVersion":0,"payload":{"schemaVersion":1,"projects":[]}}',
    ])
  })
})
