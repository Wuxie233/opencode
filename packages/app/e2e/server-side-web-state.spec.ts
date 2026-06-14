import { expect, test, type Browser, type Page } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type WebStateGroup = "server" | "layout" | "settings.v3" | "workspace:model-selection"
type WebStateRecord = {
  value: unknown
  version: string
  updated_at: number
}
type ModelPick = {
  providerID: string
  modelID: string
  name: string
  variant?: string
}
type SessionInfo = {
  id: string
}
type SeededWebState = {
  url: string
  workspace: string
  session: SessionInfo
  model: ModelPick
}

const PLUGIN_ID = "opencode.web-state"
const SMOKE_FONT = "Task10SmokeMono"
const SMOKE_SESSION_TITLE = "Playwright web-state smoke"

function backendURL() {
  return `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
}

function launchOptions() {
  if (!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return undefined
  return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWebStateRecord(value: unknown): value is WebStateRecord {
  if (!isRecord(value)) return false
  if (!("value" in value)) return false
  if (typeof value.version !== "string") return false
  if (typeof value.updated_at !== "number") return false
  return Number.isFinite(value.updated_at)
}

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function headers(directory?: string) {
  const result = new Headers({ accept: "application/json" })
  if (directory) result.set("x-opencode-directory", directory)
  return result
}

function stateURL(server: string, group: WebStateGroup) {
  return new URL(`/api/plugin/${PLUGIN_ID}/state/${group}`, server)
}

async function backendAvailable(server: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(new URL("/health", server), { signal: controller.signal })
    return response.ok
  } catch (_error) {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function getWebState(server: string, group: WebStateGroup, directory?: string) {
  const response = await fetch(stateURL(server, group), { headers: headers(directory) })
  expect(response.ok, `${group} web-state GET`).toBe(true)
  const body: unknown = await response.json()
  expect(isWebStateRecord(body), `${group} web-state record shape`).toBe(true)
  return body as WebStateRecord
}

async function putWebState(server: string, group: WebStateGroup, record: WebStateRecord, directory?: string) {
  const requestHeaders = headers(directory)
  requestHeaders.set("content-type", "application/json")
  const response = await fetch(stateURL(server, group), {
    method: "PUT",
    headers: requestHeaders,
    body: JSON.stringify(record),
  })
  expect(response.ok, `${group} web-state PUT`).toBe(true)
  const body: unknown = await response.json()
  expect(isWebStateRecord(body), `${group} web-state PUT response`).toBe(true)
  return body as WebStateRecord
}

async function createSession(server: string, directory: string) {
  const requestHeaders = headers(directory)
  requestHeaders.set("content-type", "application/json")
  const response = await fetch(new URL("/session", server), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ title: SMOKE_SESSION_TITLE }),
  })
  expect(response.ok, "session.create").toBe(true)
  const body: unknown = await response.json()
  expect(isRecord(body) && typeof body.id === "string", "session.create response").toBe(true)
  return body as SessionInfo
}

async function deleteSession(server: string, directory: string, sessionID: string) {
  const response = await fetch(new URL(`/session/${sessionID}`, server), {
    method: "DELETE",
    headers: headers(directory),
  })
  expect(response.ok, "session.delete cleanup").toBe(true)
}

async function connectedModel(server: string, directory: string) {
  const response = await fetch(new URL("/provider", server), { headers: headers(directory) })
  expect(response.ok, "provider.list").toBe(true)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.connected) || !Array.isArray(body.all)) return
  const connected = new Set(body.connected.filter((item): item is string => typeof item === "string"))
  for (const provider of body.all) {
    if (!isRecord(provider) || typeof provider.id !== "string") continue
    if (!connected.has(provider.id)) continue
    if (!isRecord(provider.models)) continue
    for (const model of Object.values(provider.models)) {
      if (!isRecord(model) || typeof model.id !== "string") continue
      return {
        providerID: provider.id,
        modelID: model.id,
        name: typeof model.name === "string" ? model.name.replace("(latest)", "").trim() : model.id,
        variant: isRecord(model.variants) ? Object.keys(model.variants)[0] : undefined,
      } satisfies ModelPick
    }
  }
}

function appSessionURL(baseURL: string | undefined, directory: string, sessionID: string) {
  return new URL(`/${base64Url(directory)}/session/${sessionID}`, baseURL ?? "http://127.0.0.1:3000").toString()
}

async function storedMono(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("settings.v3")
    if (!raw) return ""
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ""
    const appearance = (parsed as Record<string, unknown>).appearance
    if (!appearance || typeof appearance !== "object" || Array.isArray(appearance)) return ""
    const mono = (appearance as Record<string, unknown>).mono
    return typeof mono === "string" ? mono : ""
  })
}

async function storedSessionTab(page: Page, sessionKey: string) {
  return page.evaluate((input) => {
    const raw = localStorage.getItem("opencode.global.dat:layout")
    if (!raw) return ""
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ""
    const tabs = (parsed as Record<string, unknown>).sessionTabs
    if (!tabs || typeof tabs !== "object" || Array.isArray(tabs)) return ""
    const session = (tabs as Record<string, unknown>)[input]
    if (!session || typeof session !== "object" || Array.isArray(session)) return ""
    const active = (session as Record<string, unknown>).active
    return typeof active === "string" ? active : ""
  }, sessionKey)
}

async function assertRestored(page: Page, directory: string, sessionID: string, model: ModelPick) {
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/${base64Url(directory)}/session/${sessionID}`)
  await expect(page.locator("[data-session-title] [data-slot='session-title-child']")).toContainText(SMOKE_SESSION_TITLE)
  await expect(page.locator("[data-component='prompt-model-control']")).toContainText(model.name)
  await expect(page.locator("#review-panel")).toHaveAttribute("aria-hidden", "false")
  await expect.poll(() => storedMono(page)).toBe(SMOKE_FONT)
  await expect.poll(() => storedSessionTab(page, `${base64Url(directory)}/${sessionID}`)).toBe("context")
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--font-family-mono")))
    .toContain(SMOKE_FONT)
}

async function runRefreshRestore(browser: Browser, url: string, directory: string, sessionID: string, model: ModelPick) {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(url)
    await assertRestored(page, directory, sessionID, model)
    await page.reload()
    await assertRestored(page, directory, sessionID, model)
  } finally {
    await context.close()
  }
}

async function runFreshProfile(browser: Browser, url: string, directory: string, sessionID: string, model: ModelPick) {
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.clear())
  const freshPage = await context.newPage()
  try {
    await freshPage.goto(url)
    await assertRestored(freshPage, directory, sessionID, model)
  } finally {
    await context.close()
  }
}

async function withSeededWebState(server: string, baseURL: string | undefined, run: (state: SeededWebState) => Promise<void>) {
  const workspace = await mkdtemp(path.join(tmpdir(), "opencode-web-state-smoke-"))
  let session: SessionInfo | undefined
  let serverState: WebStateRecord | undefined
  let layoutState: WebStateRecord | undefined
  let settingsState: WebStateRecord | undefined
  let modelState: WebStateRecord | undefined
  let updatedAt = Date.now()
  const nextRecord = (value: unknown) => ({ value, version: "v1", updated_at: ++updatedAt })

  try {
    const model = await connectedModel(server, workspace)
    test.skip(!model, "No connected provider model is available for the model-selection restore assertion")
    if (!model) return

    const createdSession = await createSession(server, workspace)
    session = createdSession
    serverState = await getWebState(server, "server", workspace)
    layoutState = await getWebState(server, "layout", workspace)
    settingsState = await getWebState(server, "settings.v3", workspace)
    modelState = await getWebState(server, "workspace:model-selection", workspace)
    updatedAt = Math.max(
      Date.now(),
      serverState.updated_at,
      layoutState.updated_at,
      settingsState.updated_at,
      modelState.updated_at,
    )
    const sessionKey = `${base64Url(workspace)}/${createdSession.id}`
    const url = appSessionURL(baseURL, workspace, createdSession.id)

    await putWebState(
      server,
      "server",
      nextRecord({
        active: server,
        list: [],
        projects: { local: [{ worktree: workspace, expanded: true }] },
        lastProject: { local: workspace },
      }),
      workspace,
    )
    await putWebState(
      server,
      "layout",
      nextRecord({
        sidebar: { opened: true, width: 344, workspaces: {}, workspacesDefault: false },
        terminal: { height: 280, opened: false },
        review: { diffStyle: "split", panelOpened: true },
        fileTree: { opened: true, width: 260, tab: "all" },
        session: { width: 640 },
        mobileSidebar: { opened: false },
        sessionTabs: { [sessionKey]: { all: ["context"], active: "context" } },
        sessionView: { [sessionKey]: { scroll: {}, reviewOpen: [] } },
        handoff: {},
      }),
      workspace,
    )
    await putWebState(
      server,
      "settings.v3",
      nextRecord({
        general: { showFileTree: true, showStatus: true },
        appearance: { mono: SMOKE_FONT },
      }),
      workspace,
    )
    await putWebState(
      server,
      "workspace:model-selection",
      nextRecord({
        session: {
          [createdSession.id]: {
            agent: "build",
            model: { providerID: model.providerID, modelID: model.modelID },
            variant: model.variant ?? null,
          },
        },
      }),
      workspace,
    )

    await run({ url, workspace, session: createdSession, model })
  } finally {
    if (modelState) await putWebState(server, "workspace:model-selection", nextRecord(modelState.value), workspace)
    if (settingsState) await putWebState(server, "settings.v3", nextRecord(settingsState.value), workspace)
    if (layoutState) await putWebState(server, "layout", nextRecord(layoutState.value), workspace)
    if (serverState) await putWebState(server, "server", nextRecord(serverState.value), workspace)
    if (session) await deleteSession(server, workspace, session.id)
    await rm(workspace, { recursive: true, force: true })
  }
}

test("server-side web state refresh", async ({ baseURL, playwright }) => {
  const server = backendURL()
  test.skip(!(await backendAvailable(server)), `${server} is unavailable; start the opencode backend on port 4096 to run this smoke`)

  await withSeededWebState(server, baseURL, async (state) => {
    const appBrowser = await playwright.chromium.launch(launchOptions())
    try {
      await runRefreshRestore(appBrowser, state.url, state.workspace, state.session.id, state.model)
    } finally {
      await appBrowser.close()
    }
  })
})

test("server-side web state fresh profile", async ({ baseURL, playwright }) => {
  const server = backendURL()
  test.skip(!(await backendAvailable(server)), `${server} is unavailable; start the opencode backend on port 4096 to run this smoke`)

  await withSeededWebState(server, baseURL, async (state) => {
    const appBrowser = await playwright.chromium.launch(launchOptions())
    try {
      await runFreshProfile(appBrowser, state.url, state.workspace, state.session.id, state.model)
    } finally {
      await appBrowser.close()
    }
  })
})
