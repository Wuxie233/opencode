import { Hono } from "hono"
import { DurableObject } from "cloudflare:workers"
import { randomUUID } from "node:crypto"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import { Resource } from "sst"

type Env = {
  SYNC_SERVER: DurableObjectNamespace<SyncServer>
  Bucket: R2Bucket
  WEB_DOMAIN: string
}

type SidebarProjectState = {
  readonly worktree: string
  readonly expanded: boolean
}

type SidebarStatePayload = {
  readonly schemaVersion: 1
  readonly projects: readonly SidebarProjectState[]
  readonly lastProject?: string
}

type SidebarStateEnvelope = {
  readonly namespace: string
  readonly scope: string
  readonly version: number
  readonly updatedAt: string
  readonly updatedByDeviceId: string
  readonly payload: SidebarStatePayload
}

type SidebarTokenRecord = {
  readonly deviceId: string
  readonly namespace: string
}

const SIDEBAR_SYNC_DO_NAME = "sidebar-sync"
const SIDEBAR_PAIRING_TTL_MS = 10 * 60 * 1000
const sidebarForbiddenKeys = new Set([
  "password",
  "token",
  "credentials",
  "server.list",
  "list",
  "session",
  "prompt",
  "model",
  "authorization",
  "auth",
  "secret",
  "provider_auth",
  "apiKey",
  "api_key",
  "provider",
])

function sidebarValidationError(fields: Record<string, string>) {
  return { error: "ValidationError", fields }
}

function parseSidebarRequestBody(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function containsSidebarForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some((item) => containsSidebarForbiddenKey(item))
  return Object.entries(value).some(
    ([key, nested]) => sidebarForbiddenKeys.has(key) || containsSidebarForbiddenKey(nested),
  )
}

function validateSidebarRequestFields(body: Record<string, unknown>, allowedKeys: readonly string[]) {
  if (Object.keys(body).some((key) => sidebarForbiddenKeys.has(key))) return "body contains forbidden field"
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) return "body contains unsupported field"
  return undefined
}

function validateSidebarPayload(value: unknown) {
  if (containsSidebarForbiddenKey(value)) return "payload contains forbidden field"
  const payload = parseSidebarRequestBody(value)
  if (!payload) return "payload must be an object"
  if (payload.schemaVersion !== 1) return "schemaVersion must be 1"
  if (!Array.isArray(payload.projects)) return "projects must be an array"
  const invalidProject = payload.projects.find((project) => {
    const parsed = parseSidebarRequestBody(project)
    if (!parsed) return true
    return (
      Object.keys(parsed).some((key) => key !== "worktree" && key !== "expanded") ||
      typeof parsed.worktree !== "string" ||
      typeof parsed.expanded !== "boolean"
    )
  })
  if (invalidProject) return "projects must contain only worktree and expanded"
  if (payload.lastProject !== undefined && typeof payload.lastProject !== "string") return "lastProject must be a string"
  if (Object.keys(payload).some((key) => key !== "schemaVersion" && key !== "projects" && key !== "lastProject"))
    return "payload contains unsupported field"
  return undefined
}

function isValidSidebarPathParam(value: string) {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)
}

async function getSidebarAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }, namespace: string) {
  const auth = c.req.header("Authorization")?.match(/^Bearer (.+)$/)
  if (!auth) return undefined
  const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(SIDEBAR_SYNC_DO_NAME))
  const token = await stub.authorizeSidebarToken(auth[1])
  if (!token || token.namespace !== namespace) return undefined
  return token
}

export class SyncServer extends DurableObject<Env> {
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }
  async fetch() {
    console.log("SyncServer subscribe")

    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)

    this.ctx.acceptWebSocket(server)

    const data = await this.ctx.storage.list()
    Array.from(data.entries())
      .filter(([key, _]) => key.startsWith("session/"))
      .map(([key, content]) => server.send(JSON.stringify({ key, content })))

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(_ws, _message) {}

  async webSocketClose(ws, code, _reason, _wasClean) {
    ws.close(code, "Durable Object is closing WebSocket")
  }

  async publish(key: string, content: any) {
    const sessionID = await this.getSessionID()
    if (
      !key.startsWith(`session/info/${sessionID}`) &&
      !key.startsWith(`session/message/${sessionID}/`) &&
      !key.startsWith(`session/part/${sessionID}/`)
    )
      return new Response("Error: Invalid key", { status: 400 })

    // store message
    await this.env.Bucket.put(`share/${key}.json`, JSON.stringify(content), {
      httpMetadata: {
        contentType: "application/json",
      },
    })
    await this.ctx.storage.put(key, content)
    const clients = this.ctx.getWebSockets()
    console.log("SyncServer publish", key, "to", clients.length, "subscribers")
    for (const client of clients) {
      client.send(JSON.stringify({ key, content }))
    }
  }

  public async share(sessionID: string) {
    let secret = await this.getSecret()
    if (secret) return secret
    secret = randomUUID()

    await this.ctx.storage.put("secret", secret)
    await this.ctx.storage.put("sessionID", sessionID)

    return secret
  }

  public async getData() {
    const data = (await this.ctx.storage.list()) as Map<string, any>
    return Array.from(data.entries())
      .filter(([key, _]) => key.startsWith("session/"))
      .map(([key, content]) => ({ key, content }))
  }

  public async createSidebarPairing() {
    const code = randomUUID().replaceAll("-", "").slice(0, 8)
    const expiresAt = new Date(Date.now() + SIDEBAR_PAIRING_TTL_MS).toISOString()
    await this.ctx.storage.put(`sidebar/pairing/${code}`, {
      expiresAt,
      namespace: randomUUID(),
    })
    return { code, expiresAt }
  }

  public async claimSidebarPairing(code: string) {
    const pairing = await this.ctx.storage.get<{ expiresAt: string; namespace: string }>(`sidebar/pairing/${code}`)
    if (!pairing) return undefined
    if (Date.parse(pairing.expiresAt) <= Date.now()) return "expired" as const
    await this.ctx.storage.delete(`sidebar/pairing/${code}`)
    const deviceId = randomUUID()
    const token = `${pairing.namespace}.${randomUUID()}`
    await this.ctx.storage.put(`sidebar/token/${token}`, { deviceId, namespace: pairing.namespace })
    return { deviceId, token }
  }

  public async authorizeSidebarToken(token: string) {
    return this.ctx.storage.get<SidebarTokenRecord>(`sidebar/token/${token}`)
  }

  public async getSidebarState(namespace: string, scope: string) {
    return this.ctx.storage.get<SidebarStateEnvelope>(`sidebar/state/${namespace}/${scope}`)
  }

  public async putSidebarState(
    namespace: string,
    scope: string,
    baseVersion: number,
    payload: SidebarStatePayload,
    deviceId: string,
  ) {
    const current = await this.getSidebarState(namespace, scope)
    if (current && current.version !== baseVersion) return { conflict: current }
    const state = {
      namespace,
      scope,
      version: current ? current.version + 1 : 1,
      updatedAt: new Date().toISOString(),
      updatedByDeviceId: deviceId,
      payload,
    }
    await this.ctx.storage.put(`sidebar/state/${namespace}/${scope}`, state)
    return { state }
  }

  public async assertSecret(secret: string) {
    if (secret !== (await this.getSecret())) throw new Error("Invalid secret")
  }

  private async getSecret() {
    return this.ctx.storage.get<string>("secret")
  }

  private async getSessionID() {
    return this.ctx.storage.get<string>("sessionID")
  }

  async clear() {
    const sessionID = await this.getSessionID()
    const list = await this.env.Bucket.list({
      prefix: `session/message/${sessionID}/`,
      limit: 1000,
    })
    for (const item of list.objects) {
      await this.env.Bucket.delete(item.key)
    }
    await this.env.Bucket.delete(`session/info/${sessionID}`)
    await this.ctx.storage.deleteAll()
  }

  static shortName(id: string) {
    return id.substring(id.length - 8)
  }
}

export default new Hono<{ Bindings: Env }>()
  .get("/", (c) => c.text("Hello, world!"))
  .post("/sidebar-sync/pairing", async (c) => {
    const body = parseSidebarRequestBody(await c.req.json().catch(() => ({})))
    if (!body) return c.json(sidebarValidationError({ body: "body must be an object" }), { status: 400 })
    const requestError = validateSidebarRequestFields(body, ["label"])
    if (requestError) return c.json(sidebarValidationError({ body: requestError }), { status: 400 })
    if (body.label !== undefined && typeof body.label !== "string")
      return c.json(sidebarValidationError({ label: "label must be a string" }), { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(SIDEBAR_SYNC_DO_NAME))
    return c.json(await stub.createSidebarPairing())
  })
  .post("/sidebar-sync/pairing/:code/claim", async (c) => {
    const code = c.req.param("code")
    const body = parseSidebarRequestBody(await c.req.json().catch(() => ({})))
    if (!body) return c.json(sidebarValidationError({ body: "body must be an object" }), { status: 400 })
    const requestError = validateSidebarRequestFields(body, ["deviceName"])
    if (requestError) return c.json(sidebarValidationError({ body: requestError }), { status: 400 })
    if (body.deviceName !== undefined && typeof body.deviceName !== "string")
      return c.json(sidebarValidationError({ deviceName: "deviceName must be a string" }), { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(SIDEBAR_SYNC_DO_NAME))
    const claimed = await stub.claimSidebarPairing(code)
    if (!claimed) return c.json({ error: "NotFound", resource: "pairing" }, { status: 404 })
    if (claimed === "expired") return c.json({ error: "PairingExpired" }, { status: 409 })
    return c.json(claimed)
  })
  .get("/sidebar-sync/state/:namespace/:scope", async (c) => {
    const namespace = c.req.param("namespace")
    const scope = c.req.param("scope")
    if (!isValidSidebarPathParam(namespace) || !isValidSidebarPathParam(scope))
      return c.json(sidebarValidationError({ path: "namespace and scope must be valid" }), { status: 400 })
    const auth = await getSidebarAuth(c, namespace)
    if (!auth) return c.json({ error: "Unauthorized" }, { status: 401 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(SIDEBAR_SYNC_DO_NAME))
    const state = await stub.getSidebarState(namespace, scope)
    if (!state) return c.body(null, 204)
    return c.json(state)
  })
  .put("/sidebar-sync/state/:namespace/:scope", async (c) => {
    const namespace = c.req.param("namespace")
    const scope = c.req.param("scope")
    if (!isValidSidebarPathParam(namespace) || !isValidSidebarPathParam(scope))
      return c.json(sidebarValidationError({ path: "namespace and scope must be valid" }), { status: 400 })
    const auth = await getSidebarAuth(c, namespace)
    if (!auth) return c.json({ error: "Unauthorized" }, { status: 401 })
    const body = parseSidebarRequestBody(await c.req.json().catch(() => undefined))
    if (!body) return c.json(sidebarValidationError({ body: "body must be an object" }), { status: 400 })
    const requestError = validateSidebarRequestFields(body, ["baseVersion", "payload"])
    if (requestError) return c.json(sidebarValidationError({ body: requestError }), { status: 400 })
    if (typeof body.baseVersion !== "number" || !Number.isInteger(body.baseVersion) || body.baseVersion < 0)
      return c.json(sidebarValidationError({ baseVersion: "baseVersion must be a non-negative integer" }), { status: 400 })
    const payloadError = validateSidebarPayload(body.payload)
    if (payloadError) return c.json(sidebarValidationError({ payload: payloadError }), { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(SIDEBAR_SYNC_DO_NAME))
    const result = await stub.putSidebarState(
      namespace,
      scope,
      body.baseVersion,
      body.payload as SidebarStatePayload,
      auth.deviceId,
    )
    if (result.conflict) return c.json({ error: "VersionConflict", current: result.conflict }, { status: 409 })
    return c.json(result.state)
  })
  .post("/share_create", async (c) => {
    const body = await c.req.json<{ sessionID: string }>()
    const sessionID = body.sessionID
    const short = SyncServer.shortName(sessionID)
    const id = c.env.SYNC_SERVER.idFromName(short)
    const stub = c.env.SYNC_SERVER.get(id)
    const secret = await stub.share(sessionID)
    return c.json({
      secret,
      url: `https://${c.env.WEB_DOMAIN}/s/${short}`,
    })
  })
  .post("/share_delete", async (c) => {
    const body = await c.req.json<{ sessionID: string; secret: string }>()
    const sessionID = body.sessionID
    const secret = body.secret
    const id = c.env.SYNC_SERVER.idFromName(SyncServer.shortName(sessionID))
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.assertSecret(secret)
    await stub.clear()
    return c.json({})
  })
  .post("/share_delete_admin", async (c) => {
    const body = await c.req.json<{ sessionShortName: string; adminSecret: string }>()
    const sessionShortName = body.sessionShortName
    const adminSecret = body.adminSecret
    if (adminSecret !== Resource.ADMIN_SECRET.value) throw new Error("Invalid admin secret")
    const id = c.env.SYNC_SERVER.idFromName(sessionShortName)
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.clear()
    return c.json({})
  })
  .post("/share_sync", async (c) => {
    const body = await c.req.json<{
      sessionID: string
      secret: string
      key: string
      content: any
    }>()
    const name = SyncServer.shortName(body.sessionID)
    const id = c.env.SYNC_SERVER.idFromName(name)
    const stub = c.env.SYNC_SERVER.get(id)
    await stub.assertSecret(body.secret)
    await stub.publish(body.key, body.content)
    return c.json({})
  })
  .get("/share_poll", async (c) => {
    const upgradeHeader = c.req.header("Upgrade")
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return c.text("Error: Upgrade header is required", { status: 426 })
    }
    const id = c.req.query("id")
    console.log("share_poll", id)
    if (!id) return c.text("Error: Share ID is required", { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
    return stub.fetch(c.req.raw)
  })
  .get("/share_data", async (c) => {
    const id = c.req.query("id")
    console.log("share_data", id)
    if (!id) return c.text("Error: Share ID is required", { status: 400 })
    const stub = c.env.SYNC_SERVER.get(c.env.SYNC_SERVER.idFromName(id))
    const data = await stub.getData()

    let info
    const messages: Record<string, any> = {}
    data.forEach((d) => {
      const [root, type] = d.key.split("/")
      if (root !== "session") return
      if (type === "info") {
        info = d.content
        return
      }
      if (type === "message") {
        messages[d.content.id] = {
          parts: [],
          ...d.content,
        }
      }
      if (type === "part") {
        messages[d.content.messageID].parts.push(d.content)
      }
    })

    return c.json({ info, messages })
  })
  .post("/feishu", async (c) => {
    const body = (await c.req.json()) as {
      challenge?: string
      event?: {
        message?: {
          message_id?: string
          root_id?: string
          parent_id?: string
          chat_id?: string
          content?: string
        }
      }
    }
    console.log(JSON.stringify(body, null, 2))
    const challenge = body.challenge
    if (challenge) return c.json({ challenge })

    const content = body.event?.message?.content
    const parsed =
      typeof content === "string" && content.trim().startsWith("{")
        ? (JSON.parse(content) as {
            text?: string
          })
        : undefined
    const text = typeof parsed?.text === "string" ? parsed.text : typeof content === "string" ? content : ""

    let message = text.trim().replace(/^@_user_\d+\s*/, "")
    message = message.replace(/^aiden,?\s*/i, "<@759257817772851260> ")
    if (!message) return c.json({ ok: true })

    const threadId = body.event?.message?.root_id || body.event?.message?.message_id
    if (threadId) message = `${message} [${threadId}]`

    const response = await fetch(
      `https://discord.com/api/v10/channels/${Resource.DISCORD_SUPPORT_CHANNEL_ID.value}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${Resource.DISCORD_SUPPORT_BOT_TOKEN.value}`,
        },
        body: JSON.stringify({
          content: `${message}`,
        }),
      },
    )

    if (!response.ok) {
      console.error(await response.text())
      return c.json({ error: "Discord bot message failed" }, { status: 502 })
    }

    return c.json({ ok: true })
  })
  /**
   * Used by the GitHub action to get GitHub installation access token given the OIDC token
   */
  .post("/exchange_github_app_token", async (c) => {
    const EXPECTED_AUDIENCE = "opencode-github-action"
    const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
    const JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`

    // get Authorization header
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "")
    if (!token) return c.json({ error: "Authorization header is required" }, { status: 401 })

    // verify token
    const JWKS = createRemoteJWKSet(new URL(JWKS_URL))
    let owner, repo
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: GITHUB_ISSUER,
        audience: EXPECTED_AUDIENCE,
      })
      const sub = payload.sub // e.g. 'repo:my-org/my-repo:ref:refs/heads/main'
      const parts = sub.split(":")[1].split("/")
      owner = parts[0]
      repo = parts[1]
    } catch (err) {
      console.error("Token verification failed:", err)
      return c.json({ error: "Invalid or expired token" }, { status: 403 })
    }

    // Create app JWT token
    const auth = createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    })
    const appAuth = await auth({ type: "app" })

    // Lookup installation
    const octokit = new Octokit({ auth: appAuth.token })
    const { data: installation } = await octokit.apps.getRepoInstallation({
      owner,
      repo,
    })

    // Get installation token
    const installationAuth = await auth({
      type: "installation",
      installationId: installation.id,
    })

    return c.json({ token: installationAuth.token })
  })
  /**
   * Used by the GitHub action to get GitHub installation access token given user PAT token (used when testing `opencode github run` locally)
   */
  .post("/exchange_github_app_token_with_pat", async (c) => {
    const body = await c.req.json<{ owner: string; repo: string }>()
    const owner = body.owner
    const repo = body.repo

    try {
      // get Authorization header
      const authHeader = c.req.header("Authorization")
      const token = authHeader?.replace(/^Bearer /, "")
      if (!token) throw new Error("Authorization header is required")

      // Verify permissions
      const userClient = new Octokit({ auth: token })
      const { data: repoData } = await userClient.repos.get({ owner, repo })
      if (!repoData.permissions.admin && !repoData.permissions.push && !repoData.permissions.maintain)
        throw new Error("User does not have write permissions")

      // Get installation token
      const auth = createAppAuth({
        appId: Resource.GITHUB_APP_ID.value,
        privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
      })
      const appAuth = await auth({ type: "app" })

      // Lookup installation
      const appClient = new Octokit({ auth: appAuth.token })
      const { data: installation } = await appClient.apps.getRepoInstallation({
        owner,
        repo,
      })

      // Get installation token
      const installationAuth = await auth({
        type: "installation",
        installationId: installation.id,
      })

      return c.json({ token: installationAuth.token })
    } catch (e: any) {
      let error = e
      if (e instanceof Error) {
        error = e.message
      }

      return c.json({ error }, { status: 401 })
    }
  })
  /**
   * Used by the opencode CLI to check if the GitHub app is installed
   */
  .get("/get_github_app_installation", async (c) => {
    const owner = c.req.query("owner")
    const repo = c.req.query("repo")

    const auth = createAppAuth({
      appId: Resource.GITHUB_APP_ID.value,
      privateKey: Resource.GITHUB_APP_PRIVATE_KEY.value,
    })
    const appAuth = await auth({ type: "app" })

    // Lookup installation
    const octokit = new Octokit({ auth: appAuth.token })
    let installation
    try {
      const ret = await octokit.apps.getRepoInstallation({ owner, repo })
      installation = ret.data
    } catch (err) {
      if (err instanceof Error && err.message.includes("Not Found")) {
        // not installed
      } else {
        throw err
      }
    }

    return c.json({ installation })
  })
  .all("*", (c) => c.text("Not Found"))
