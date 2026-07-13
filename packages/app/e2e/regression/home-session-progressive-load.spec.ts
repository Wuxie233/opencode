import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const fastDirectory = "C:/OpenCode/HomeProgressive/Fast"
const slowDirectory = "C:/OpenCode/HomeProgressive/Slow"
const fastTitle = "Fast project session"
const slowTitle = "Slow project session"

const projects = [
  project("proj_home_progressive_fast", fastDirectory, "home-progressive-fast"),
  project("proj_home_progressive_slow", slowDirectory, "home-progressive-slow"),
]
const sessions = [
  session("ses_home_progressive_fast", projects[0]!.id, fastDirectory, fastTitle, 1700000001000),
  session("ses_home_progressive_slow", projects[1]!.id, slowDirectory, slowTitle, 1700000000000),
]

test("shows sessions from a completed directory while another directory is still loading", async ({ page }) => {
  let releaseSlow!: () => void
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  const requests = { slow: 0, completed: 0 }
  const limits = new Map<string, string[]>()

  await setup(page, async (route, directory, url) => {
    limits.set(directory, [...(limits.get(directory) ?? []), url.searchParams.get("limit") ?? "unbounded"])
    if (directory === fastDirectory) return json(route, [sessions[0]])
    if (directory !== slowDirectory) return json(route, [])

    requests.slow++
    await slowGate
    requests.completed++
    return json(route, [sessions[1]])
  })

  await page.goto("/")

  try {
    await expect.poll(() => requests.slow).toBeGreaterThan(0)
    await expect(page.locator('[data-component="home-session-row"]', { hasText: fastTitle })).toBeVisible()
    expect(requests.completed).toBe(0)
  } finally {
    releaseSlow()
  }

  await expect(page.locator('[data-component="home-session-row"]', { hasText: slowTitle })).toBeVisible()
  expectHomeRequest(limits.get(fastDirectory))
  expectHomeRequest(limits.get(slowDirectory))
})

function expectHomeRequest(limits: string[] | undefined) {
  expect(limits).toHaveLength(1)
  expect(Number(limits?.[0])).toBeGreaterThanOrEqual(64)
}

async function setup(page: Page, listSessions: (route: Route, directory: string, url: URL) => Promise<void>) {
  await mockOpenCodeServer(page, {
    directory: fastDirectory,
    project: projects[0],
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
  })

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const directory = url.searchParams.get("directory") ?? fastDirectory

    if (url.pathname === "/project") return json(route, projects)
    if (url.pathname === "/project/current") {
      return json(route, projects.find((item) => item.worktree === directory) ?? projects[0])
    }
    if (url.pathname === "/path") {
      return json(route, {
        state: directory,
        config: directory,
        worktree: directory,
        directory,
        home: "C:/OpenCode",
      })
    }
    if (url.pathname === "/session") return listSessions(route, directory, url)
    return route.fallback()
  })

  await page.addInitScript(
    (directories) => {
      localStorage.setItem("opencode.global.dat:settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server.projects",
        JSON.stringify({
          projects: { local: directories.map((worktree) => ({ worktree, expanded: true })) },
          lastProject: { local: directories[0] },
          recentlyClosed: {},
        }),
      )
    },
    [fastDirectory, slowDirectory],
  )
}

function project(id: string, worktree: string, name: string) {
  return {
    id,
    worktree,
    vcs: "git",
    name,
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session(id: string, projectID: string, directory: string, title: string, updated: number) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: updated, updated },
  }
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
