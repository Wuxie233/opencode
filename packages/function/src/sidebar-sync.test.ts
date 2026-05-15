import { beforeEach, describe, expect, mock, test } from "bun:test"

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
    {
      worktree: "/tmp/opencode-b",
      expanded: false,
    },
  ],
  lastProject: "/tmp/opencode-a",
}

describe("sidebar sync worker API", async () => {
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
        const next = {
          namespace,
          scope,
          version: current ? current.version + 1 : 1,
          updatedAt: new Date().toISOString(),
          updatedByDeviceId: deviceId,
          payload,
        }
        this.states.set(`${namespace}/${scope}`, next)
        return { state: next }
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

  test("device can create and claim pairing then GET and PUT state", async () => {
    const pairing = await api.request("/sidebar-sync/pairing", { method: "POST", body: "{}" }, env)
    expect(pairing.status).toBe(200)
    const pairingBody = (await pairing.json()) as { code: string; expiresAt: string }
    expect(pairingBody.code).toBeString()
    expect(pairingBody.expiresAt).toBeString()

    const claimed = await api.request(
      `/sidebar-sync/pairing/${pairingBody.code}/claim`,
      { method: "POST", body: JSON.stringify({ deviceName: "laptop" }) },
      env,
    )
    expect(claimed.status).toBe(200)
    const claimedBody = (await claimed.json()) as { deviceId: string; token: string }
    const namespace = claimedBody.token.split(".")[0]
    expect(claimedBody.deviceId).toBeString()
    expect(claimedBody.token).toBeString()

    const empty = await api.request(`/sidebar-sync/state/${namespace}/local`, {
      headers: { Authorization: `Bearer ${claimedBody.token}` },
    }, env)
    expect(empty.status).toBe(204)

    const put = await api.request(
      `/sidebar-sync/state/${namespace}/local`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimedBody.token}` },
        body: JSON.stringify({ baseVersion: 0, payload: sidebarPayload }),
      },
      env,
    )
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as { version: number; updatedByDeviceId: string; payload: typeof sidebarPayload }
    expect(putBody.version).toBe(1)
    expect(putBody.updatedByDeviceId).toBe(claimedBody.deviceId)
    expect(putBody.payload).toEqual(sidebarPayload)

    const got = await api.request(`/sidebar-sync/state/${namespace}/local`, {
      headers: { Authorization: `Bearer ${claimedBody.token}` },
    }, env)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual(putBody)
  })

  test("stale baseVersion returns VersionConflict with current state", async () => {
    const pairing = (await (await api.request("/sidebar-sync/pairing", { method: "POST", body: "{}" }, env)).json()) as {
      code: string
    }
    const claimed = (await (
      await api.request(`/sidebar-sync/pairing/${pairing.code}/claim`, { method: "POST", body: "{}" }, env)
    ).json()) as { token: string }
    const namespace = claimed.token.split(".")[0]

    await api.request(
      `/sidebar-sync/state/${namespace}/local`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimed.token}` },
        body: JSON.stringify({ baseVersion: 0, payload: sidebarPayload }),
      },
      env,
    )
    const stale = await api.request(
      `/sidebar-sync/state/${namespace}/local`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimed.token}` },
        body: JSON.stringify({ baseVersion: 0, payload: { ...sidebarPayload, lastProject: "/tmp/opencode-b" } }),
      },
      env,
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({
      error: "VersionConflict",
      current: expect.objectContaining({ version: 1, payload: sidebarPayload }),
    })
  })

  test("payload with forbidden fields is rejected and not logged", async () => {
    const logs: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => logs.push(args)
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      const pairing = (await (await api.request("/sidebar-sync/pairing", { method: "POST", body: "{}" }, env)).json()) as {
        code: string
      }
      const claimed = (await (
        await api.request(`/sidebar-sync/pairing/${pairing.code}/claim`, { method: "POST", body: "{}" }, env)
      ).json()) as { token: string }
      const namespace = claimed.token.split(".")[0]
      const rejected = await api.request(
        `/sidebar-sync/state/${namespace}/local`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${claimed.token}` },
          body: JSON.stringify({
            baseVersion: 0,
            payload: {
              ...sidebarPayload,
              token: "do-not-log",
            },
          }),
        },
        env,
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({
        error: "ValidationError",
        fields: { payload: expect.stringContaining("forbidden") },
      })
      expect(logs.flat().join(" ")).not.toContain("do-not-log")

      const empty = await api.request(`/sidebar-sync/state/${namespace}/local`, {
        headers: { Authorization: `Bearer ${claimed.token}` },
      }, env)
      expect(empty.status).toBe(204)
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })

  test("pairing rejects unsupported top-level fields without logging values", async () => {
    const logs: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => logs.push(args)
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      const rejected = await api.request(
        "/sidebar-sync/pairing",
        { method: "POST", body: JSON.stringify({ label: "laptop", token: "do-not-log" }) },
        env,
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({
        error: "ValidationError",
        fields: { body: expect.stringContaining("forbidden") },
      })
      expect(logs.flat().join(" ")).not.toContain("do-not-log")
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })

  test("claim rejects unsupported top-level fields before consuming pairing", async () => {
    const logs: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => logs.push(args)
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      const pairing = (await (await api.request("/sidebar-sync/pairing", { method: "POST", body: "{}" }, env)).json()) as {
        code: string
      }
      const rejected = await api.request(
        `/sidebar-sync/pairing/${pairing.code}/claim`,
        { method: "POST", body: JSON.stringify({ deviceName: "laptop", "server.list": ["do-not-log"] }) },
        env,
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({
        error: "ValidationError",
        fields: { body: expect.stringContaining("forbidden") },
      })
      expect(logs.flat().join(" ")).not.toContain("do-not-log")

      const claimed = await api.request(
        `/sidebar-sync/pairing/${pairing.code}/claim`,
        { method: "POST", body: "{}" },
        env,
      )
      expect(claimed.status).toBe(200)
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })

  test("PUT rejects unsupported top-level fields before persisting state", async () => {
    const logs: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => logs.push(args)
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      const pairing = (await (await api.request("/sidebar-sync/pairing", { method: "POST", body: "{}" }, env)).json()) as {
        code: string
      }
      const claimed = (await (
        await api.request(`/sidebar-sync/pairing/${pairing.code}/claim`, { method: "POST", body: "{}" }, env)
      ).json()) as { token: string }
      const namespace = claimed.token.split(".")[0]

      const topLevelToken = await api.request(
        `/sidebar-sync/state/${namespace}/local`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${claimed.token}` },
          body: JSON.stringify({ baseVersion: 0, payload: sidebarPayload, token: "do-not-log" }),
        },
        env,
      )
      expect(topLevelToken.status).toBe(400)
      expect(await topLevelToken.json()).toEqual({
        error: "ValidationError",
        fields: { body: expect.stringContaining("forbidden") },
      })

      const unrelated = await api.request(
        `/sidebar-sync/state/${namespace}/local`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${claimed.token}` },
          body: JSON.stringify({ baseVersion: 0, payload: sidebarPayload, unrelated: "do-not-log" }),
        },
        env,
      )
      expect(unrelated.status).toBe(400)
      expect(await unrelated.json()).toEqual({
        error: "ValidationError",
        fields: { body: expect.stringContaining("unsupported") },
      })
      expect(logs.flat().join(" ")).not.toContain("do-not-log")

      const empty = await api.request(`/sidebar-sync/state/${namespace}/local`, {
        headers: { Authorization: `Bearer ${claimed.token}` },
      }, env)
      expect(empty.status).toBe(204)
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })
})
