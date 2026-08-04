import { expect, test, type Page } from "@playwright/test"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/PersonalShell"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const project = {
  id: "project-personal-shell",
  worktree: directory,
  vcs: "git",
  name: "Personal Shell",
  time: { created: 1, updated: 2 },
  sandboxes: [],
}

test("commits Personal selection before target messages finish loading", async ({ page }) => {
  const targetHistory = Promise.withResolvers<void>()
  const requests: { phase: "start" | "end" }[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: [project, emptyProject],
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: (sessionID) => ({ items: sessionID === "ses_beta" ? [targetMessage()] : [] }),
    beforeMessagesResponse: ({ sessionID, before }) => {
      if (sessionID !== "ses_beta" || before) return Promise.resolve()
      return targetHistory.promise
    },
    onMessages: ({ sessionID, before, phase }) => {
      if (sessionID === "ses_beta" && !before) requests.push({ phase })
    },
  })
  await installPersonalState(page, "light")
  const alphaHref = sessionHref(ServerConnection.Key.make(server), "ses_alpha")
  const betaHref = sessionHref(ServerConnection.Key.make(server), "ses_beta")
  await page.goto(alphaHref)

  const rail = page.locator("aside.personal-rail")
  const beta = rail.getByRole("button", { name: /Beta task/ })
  const historyLength = await page.evaluate(() => window.history.length)
  await beta.click()
  await expect.poll(() => requests.some((request) => request.phase === "start")).toBe(true)
  expect(requests.some((request) => request.phase === "end")).toBe(false)
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(betaHref)}$`), { timeout: 2_000 })
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength + 1)
  await expect(beta).toHaveAttribute("aria-current", "page", { timeout: 2_000 })
  await expect(page.locator('[data-timeline-part-id="prt_beta_target"]')).toHaveCount(0)

  targetHistory.resolve()
  await expect.poll(() => requests.some((request) => request.phase === "end")).toBe(true)
  await expect(page.locator('[data-timeline-part-id="prt_beta_target"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength + 1)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(alphaHref)}$`))
})

test("renames from the menu and double-click and opens native Settings", async ({ page }) => {
  const updates: { sessionID: string; body: unknown }[] = []
  await setup(page, "light", { onSessionUpdate: (input) => updates.push(input) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/")

  const rail = page.locator("aside.personal-rail")
  const alphaRow = rail.locator(".personal-session-row").filter({ hasText: "Alpha session" })
  await alphaRow.getByRole("button", { name: "Session actions" }).click()
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const menuEditor = rail.getByRole("textbox", { name: "Rename" })
  await menuEditor.fill("Menu title")
  await menuEditor.press("Enter")
  await expect.poll(() => updates.at(-1)).toEqual({ sessionID: "ses_alpha", body: { title: "Menu title" } })
  await expect(menuEditor).toHaveCount(0)

  const beta = rail.getByRole("button", { name: /Beta task/ })
  await beta.dblclick()
  const doubleClickEditor = rail.getByRole("textbox", { name: "Rename" })
  await doubleClickEditor.fill("Double-click title")
  await doubleClickEditor.press("Enter")
  await expect.poll(() => updates.at(-1)).toEqual({ sessionID: "ses_beta", body: { title: "Double-click title" } })

  const settings = rail.getByRole("button", { name: "Settings" })
  const railBox = await rail.boundingBox()
  const settingsBox = await settings.boundingBox()
  expect(settingsBox?.y).toBeGreaterThan((railBox?.y ?? 0) + (railBox?.height ?? 0) - 80)
  await settings.click()
  await expect(page.locator('[data-component="dialog-v2"][data-variant="settings"]')).toBeVisible()
  await expect(page.getByRole("tab", { name: "General" })).toBeVisible()
})

test("archives the selected conversation and automatically closes its tab", async ({ page }) => {
  const updates: { sessionID: string; body: unknown }[] = []
  await setup(page, "light", { onSessionUpdate: (input) => updates.push(input) })
  await page.setViewportSize({ width: 1440, height: 900 })
  const alphaHref = sessionHref(ServerConnection.Key.make(server), "ses_alpha")
  const betaHref = sessionHref(ServerConnection.Key.make(server), "ses_beta")
  await page.goto(alphaHref)

  const rail = page.locator("aside.personal-rail")
  const alphaRow = rail.locator(".personal-session-row").filter({ hasText: "Alpha session" })
  await alphaRow.getByRole("button", { name: "Session actions" }).click()
  await page.getByRole("menuitem", { name: "Archive session" }).click()

  await expect.poll(() => updates.at(-1)).toEqual({
    sessionID: "ses_alpha",
    body: { time: { archived: expect.any(Number) } },
  })
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(betaHref)}$`))
  await expect(rail.getByRole("button", { name: /Alpha session/ })).toHaveCount(0)
  await expect(rail.getByRole("button", { name: /Beta task/ })).toHaveAttribute("aria-current", "page")
})

test("keeps the conversation tab open when archive fails", async ({ page }) => {
  await setup(page, "light", { sessionUpdateStatus: 500 })
  await page.setViewportSize({ width: 1440, height: 900 })
  const alphaHref = sessionHref(ServerConnection.Key.make(server), "ses_alpha")
  await page.goto(alphaHref)

  const rail = page.locator("aside.personal-rail")
  const alphaRow = rail.locator(".personal-session-row").filter({ hasText: "Alpha session" })
  await alphaRow.getByRole("button", { name: "Session actions" }).click()
  await page.getByRole("menuitem", { name: "Archive session" }).click()

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(alphaHref)}$`))
  await expect(rail.getByRole("button", { name: /Alpha session/ })).toHaveAttribute("aria-current", "page")
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
})
const emptyProject = {
  id: "project-empty",
  worktree: "C:/OpenCode/EmptyProject",
  vcs: "git",
  name: "Empty Project",
  time: { created: 1, updated: 1 },
  sandboxes: [],
}
const sessions = [
  session("ses_alpha", "Alpha session", 3),
  session("ses_beta", "Beta task", 2),
  session("ses_closed", "Closed history", 1),
]

for (const mode of [
  { name: "light-normal", scheme: "light" as const, reducedMotion: "no-preference" as const },
  { name: "dark-reduced", scheme: "dark" as const, reducedMotion: "reduce" as const },
]) {
  test(`renders and filters the desktop Personal rail in ${mode.name}`, async ({ page }, testInfo) => {
    await setup(page, mode.scheme)
    await page.emulateMedia({ colorScheme: mode.scheme, reducedMotion: mode.reducedMotion })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/")

    const rail = page.locator("aside.personal-rail")
    await expect(rail).toBeVisible()
    await expect(rail.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-current", "page")
    await expect(rail.getByRole("button", { name: /Alpha session/ })).toBeVisible()
    await expect(rail.getByRole("button", { name: /Beta task/ })).toBeVisible()
    await expect(rail.getByRole("button", { name: /Closed history/ })).toHaveCount(0)
    await expect(rail.getByRole("button", { name: /Empty Project/ })).toHaveCount(0)

    const search = rail.getByRole("searchbox", { name: "Search projects and sessions" })
    await search.fill("beta")
    await expect(rail.getByRole("button", { name: /Alpha session/ })).toHaveCount(0)
    await expect(rail.getByRole("button", { name: /Beta task/ })).toBeVisible()
    await search.fill("")

    const projectToggle = rail.getByRole("button", { name: /Personal Shell/ })
    await projectToggle.click()
    await expect(projectToggle).toHaveAttribute("aria-expanded", "false")
    await expect(rail.getByRole("button", { name: /Alpha session/ })).toBeHidden()
    await projectToggle.click()
    await expect(rail.getByRole("button", { name: /Alpha session/ })).toBeVisible()

    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: testInfo.outputPath(`personal-shell-1440-${mode.name}.png`), fullPage: true })
  })

  test(`uses an accessible Personal drawer below 1080px in ${mode.name}`, async ({ page }, testInfo) => {
    await setup(page, mode.scheme)
    await page.emulateMedia({ colorScheme: mode.scheme, reducedMotion: mode.reducedMotion })
    await page.setViewportSize({ width: 1000, height: 760 })
    await page.goto("/")

    const trigger = page.getByRole("button", { name: "Open project navigation" })
    const box = await trigger.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
    await expect(page.locator("aside.personal-rail")).toBeHidden()

    const drawer = page.locator("#personal-navigation-drawer")
    for (const width of [1000, 767, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await trigger.click()
      await expect(drawer).toBeVisible()
      await expect(drawer.getByRole("button", { name: /Alpha session/ })).toBeVisible()
      await expect(drawer.getByRole("button", { name: /Empty Project/ })).toHaveCount(0)
      const settings = drawer.getByRole("button", { name: "Settings" })
      const settingsBox = await settings.boundingBox()
      expect(settingsBox?.width).toBeGreaterThanOrEqual(44)
      expect(settingsBox?.height).toBeGreaterThanOrEqual(44)
      await expectDrawerGeometry(drawer, width)
      await expectNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`personal-shell-${width}-${mode.name}.png`), fullPage: true })
      if (width === 390) {
        await settings.click()
        const dialog = page.locator('[data-component="dialog-v2"][data-variant="settings"]')
        await expect(dialog).toBeVisible()
        continue
      }
      await drawer.getByRole("button", { name: "Close project navigation" }).click()
      await expect(drawer).toBeHidden()
      await expect(trigger).toBeFocused()
    }
  })
}

async function setup(
  page: Page,
  scheme: "light" | "dark",
  options?: Pick<Parameters<typeof mockOpenCodeServer>[1], "onSessionUpdate" | "sessionUpdateStatus">,
) {
  await mockOpenCodeServer(page, {
    directory,
    project: [project, emptyProject],
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
    ...options,
  })
  await installPersonalState(page, scheme)
}

async function installPersonalState(page: Page, scheme: "light" | "dark") {
  await page.addInitScript(
    ({ directory, scheme, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode-color-scheme", scheme)
      localStorage.setItem(
        "opencode.global.dat:server.projects",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
          recentlyClosed: {},
        }),
      )
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [], active: server }))
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server, sessionId: "ses_alpha" },
          { type: "session", server, sessionId: "ses_beta" },
        ]),
      )
    },
    { directory, scheme, server },
  )
}

function targetMessage() {
  return {
    info: {
      id: "msg_beta_target",
      sessionID: "ses_beta",
      role: "user",
      time: { created: 2 },
      agent: "build",
      model: { providerID: "opencode", modelID: "test" },
    },
    parts: [
      {
        id: "prt_beta_target",
        sessionID: "ses_beta",
        messageID: "msg_beta_target",
        type: "text",
        text: "Delayed beta content",
      },
    ],
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    })),
  ).toEqual({ document: 0, body: 0 })
}

async function expectDrawerGeometry(drawer: ReturnType<Page["locator"]>, viewportWidth: number) {
  await expect
    .poll(async () => Math.round((await drawer.boundingBox())?.x ?? Number.NEGATIVE_INFINITY))
    .toBeGreaterThanOrEqual(5)
  const box = await drawer.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  expect(box.x).toBeGreaterThanOrEqual(5)
  expect(box.x).toBeLessThanOrEqual(7)
  expect(box.width).toBeGreaterThanOrEqual(Math.min(320, viewportWidth - 12) - 1)
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth - 5)
}

function session(id: string, title: string, updated: number) {
  return {
    id,
    slug: id,
    projectID: project.id,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated },
  }
}
