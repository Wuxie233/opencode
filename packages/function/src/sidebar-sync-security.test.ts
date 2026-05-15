import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"

void mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: unknown

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

void mock.module("jose", () => ({
  createRemoteJWKSet: () => () => undefined,
  jwtVerify: () => ({ payload: { sub: "repo:owner/repo:ref:refs/heads/dev" } }),
}))

void mock.module("@octokit/auth-app", () => ({
  createAppAuth: () => () => ({ token: "test" }),
}))

void mock.module("@octokit/rest", () => ({
  Octokit: class {},
}))

void mock.module("sst", () => ({
  Resource: {
    ADMIN_SECRET: { value: "admin" },
    DISCORD_SUPPORT_CHANNEL_ID: { value: "channel" },
    DISCORD_SUPPORT_BOT_TOKEN: { value: "bot" },
    GITHUB_APP_ID: { value: "app" },
    GITHUB_APP_PRIVATE_KEY: { value: "private" },
  },
}))

const sidebarPayload = {
  schemaVersion: 1,
  projects: [
    {
      worktree: "/tmp/opencode-a",
      expanded: true,
    },
  ],
  lastProject: "/tmp/opencode-a",
}

const forbiddenKeys = [
  "password",
  "token",
  "credentials",
  "secret",
  "authorization",
  "provider_auth",
  "session",
  "prompt",
  "model",
  "list",
] as const

const sidebarSyncDir = path.join(import.meta.dirname, "..", "..", "sidebar-sync")

async function withConsoleCapture<T>(run: (logs: unknown[][]) => Promise<T>) {
  const logs: unknown[][] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => logs.push(args)
  console.error = (...args: unknown[]) => logs.push(args)
  try {
    return await run(logs)
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

describe("sidebar sync security regressions", async () => {
  const api = (await import("./api")).default
  let env: {
    SYNC_SERVER: DurableObjectNamespace
    Bucket: R2Bucket
    WEB_DOMAIN: string
  }

  beforeEach(() => {
    const stub = {
      pairings: new Map<string, { expiresAt: string; namespace: string }>(),
      tokens: new Map<string, { deviceId: string; namespace: string }>(),
      states: new Map<string, unknown>(),
      shareSecret: "share-secret",
      shareSessionID: "session-12345678",
      async createSidebarPairing() {
        const code = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        this.pairings.set(code, { expiresAt, namespace: crypto.randomUUID() })
        return { code, expiresAt }
      },
      async claimSidebarPairing(code: string) {
        const pairing = this.pairings.get(code)
        if (!pairing) return undefined
        const deviceId = crypto.randomUUID()
        const token = `${pairing.namespace}.${crypto.randomUUID()}`
        this.tokens.set(token, { deviceId, namespace: pairing.namespace })
        return { deviceId, token }
      },
      async authorizeSidebarToken(token: string) {
        return this.tokens.get(token)
      },
      async getSidebarState(namespace: string, scope: string) {
        return this.states.get(`${namespace}/${scope}`)
      },
      async putSidebarState(namespace: string, scope: string, baseVersion: number, payload: unknown, deviceId: string) {
        const current = this.states.get(`${namespace}/${scope}`) as { version: number } | undefined
        if (current && current.version !== baseVersion) return { conflict: current }
        const state = {
          namespace,
          scope,
          version: current ? current.version + 1 : 1,
          updatedAt: new Date().toISOString(),
          updatedByDeviceId: deviceId,
          payload,
        }
        this.states.set(`${namespace}/${scope}`, state)
        return { state }
      },
      async share(sessionID: string) {
        this.shareSessionID = sessionID
        return this.shareSecret
      },
      async assertSecret(secret: string) {
        if (secret !== this.shareSecret) throw new Error("Invalid secret")
      },
      async clear() {
        this.states.clear()
      },
      async getData() {
        return [
          {
            key: `session/info/${this.shareSessionID}`,
            content: { id: this.shareSessionID, title: "Smoke" },
          },
          {
            key: `session/message/${this.shareSessionID}/message-1`,
            content: { id: "message-1", role: "user" },
          },
          {
            key: `session/part/${this.shareSessionID}/part-1`,
            content: { id: "part-1", messageID: "message-1", text: "hello" },
          },
        ]
      },
    }

    env = {
      SYNC_SERVER: {
        idFromName: (name: string) => name,
        get: () => stub,
      } as unknown as DurableObjectNamespace,
      Bucket: {} as R2Bucket,
      WEB_DOMAIN: "example.com",
    }
  })

  test("worker rejects forbidden payload keys at any depth without echoing payload or logging secrets", async () => {
    await withConsoleCapture(async (logs) => {
      const pairing = (await (await api.request("/sidebar-sync/pairing", { method: "POST", body: "{}" }, env)).json()) as {
        code: string
      }
      const claimed = (await (
        await api.request(`/sidebar-sync/pairing/${pairing.code}/claim`, { method: "POST", body: "{}" }, env)
      ).json()) as { token: string }
      const namespace = claimed.token.split(".")[0]
      const secretValue = "raw-secret-local-storage-value"

      await Promise.all(
        forbiddenKeys.map(async (key) => {
          const rejected = await api.request(
            `/sidebar-sync/state/${namespace}/local`,
            {
              method: "PUT",
              headers: { Authorization: `Bearer ${claimed.token}` },
              body: JSON.stringify({
                baseVersion: 0,
                payload: {
                  ...sidebarPayload,
                  nested: {
                    deeper: {
                      [key]: secretValue,
                    },
                  },
                },
              }),
            },
            env,
          )
          const body = (await rejected.json()) as { error: string; fields: Record<string, string> }
          expect(rejected.status).toBe(400)
          expect(body).toEqual({
            error: "ValidationError",
            fields: { payload: expect.stringContaining("forbidden") },
          })
          expect(JSON.stringify(body)).not.toContain(secretValue)
          expect(JSON.stringify(body)).not.toContain("nested")
        }),
      )

      const empty = await api.request(`/sidebar-sync/state/${namespace}/local`, {
        headers: { Authorization: `Bearer ${claimed.token}` },
      }, env)
      expect(empty.status).toBe(204)
      expect(logs.flat().join(" ")).not.toContain(claimed.token)
      expect(logs.flat().join(" ")).not.toContain(secretValue)
      expect(logs.flat().join(" ")).not.toContain("raw-secret-local-storage-value")
      expect(logs.flat().join(" ")).not.toContain(JSON.stringify(sidebarPayload))
    })
  })

  test("artifact manifest contains only safe hash metadata", async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], {
      cwd: sidebarSyncDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0)

    const manifest = (await Bun.file(path.join(sidebarSyncDir, "dist", "manifest.json")).json()) as {
      version: string
      generatedAt: string
      artifacts: Array<Record<string, string>>
      warnings?: string[]
    }

    expect(manifest.version).toBeString()
    expect(manifest.generatedAt).toBeString()
    expect(manifest.artifacts.length).toBeGreaterThan(0)
    expect(manifest.artifacts.every((artifact) => Object.keys(artifact).sort().join(",") === "path,sha256")).toBe(true)
    expect(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(JSON.stringify(manifest)).not.toContain("raw-secret-local-storage-value")
    expect(JSON.stringify(manifest)).not.toContain("opencode.global.dat:server")
    expect(JSON.stringify(manifest)).not.toContain("server.v3")
    expect(JSON.stringify(manifest)).not.toContain("provider_auth")
    expect(JSON.stringify(manifest)).not.toContain("authorization")
  })

  test("existing share endpoints keep their response shape", async () => {
    const created = await api.request(
      "/share_create",
      { method: "POST", body: JSON.stringify({ sessionID: "session-abcdef12" }) },
      env,
    )
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({
      secret: "share-secret",
      url: "https://example.com/s/abcdef12",
    })

    const data = await api.request("/share_data?id=abcdef12", {}, env)
    expect(data.status).toBe(200)
    expect(await data.json()).toEqual({
      info: { id: "session-abcdef12", title: "Smoke" },
      messages: {
        "message-1": {
          id: "message-1",
          role: "user",
          parts: [{ id: "part-1", messageID: "message-1", text: "hello" }],
        },
      },
    })
  })
})
