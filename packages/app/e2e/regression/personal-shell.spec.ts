import { expect, test, type Page } from "@playwright/test"
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
      await expectDrawerGeometry(drawer, width)
      await expectNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`personal-shell-${width}-${mode.name}.png`), fullPage: true })
      await drawer.getByRole("button", { name: "Close project navigation" }).click()
      await expect(drawer).toBeHidden()
      await expect(trigger).toBeFocused()
    }
  })
}

async function setup(page: Page, scheme: "light" | "dark") {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
  })
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
