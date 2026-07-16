import { expect, test, type Browser } from "@playwright/test"

// Server-side web-state smoke for Option B.
//
// In Option B the app server-backs exactly two global groups: "settings.v3" and
// "tabs" (see context/settings.tsx and context/tabs.tsx, both via
// Persist.serverGlobal(server.scope(), ...)). Server-backing is gated on a
// non-local scope; a web build talking to a localhost backend resolves the
// backend URL as its scope, so the gate is open here.
//
// These tests hit the real opencode backend's opencode.web-state plugin route
// (implemented server-side). They skip when no backend is reachable.

type WebStateGroup = "settings.v3" | "tabs"
type WebStateRecord = {
  value: unknown
  version: string
  updated_at: number
}

const PLUGIN_ID = "opencode.web-state"
const SMOKE_FONT = "Task10SmokeMono"

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

function stateURL(server: string, group: WebStateGroup) {
  return new URL(`/api/plugin/${PLUGIN_ID}/state/${group}`, server)
}

async function backendAvailable(server: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(new URL("/global/health", server), { signal: controller.signal })
    return response.ok
  } catch (_error) {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function getWebState(server: string, group: WebStateGroup) {
  const response = await fetch(stateURL(server, group), { headers: { accept: "application/json" } })
  expect(response.ok, `${group} web-state GET`).toBe(true)
  const body: unknown = await response.json()
  expect(isWebStateRecord(body), `${group} web-state record shape`).toBe(true)
  return body as WebStateRecord
}

async function putWebState(server: string, group: WebStateGroup, record: WebStateRecord) {
  const response = await fetch(stateURL(server, group), {
    method: "PUT",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(record),
  })
  expect(response.ok, `${group} web-state PUT`).toBe(true)
  const body: unknown = await response.json()
  expect(isWebStateRecord(body), `${group} web-state PUT response`).toBe(true)
  return body as WebStateRecord
}

async function restoreFontFromServer(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.clear())
  const page = await context.newPage()
  try {
    await page.goto(baseURL ?? "http://127.0.0.1:3000")
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--font-family-mono")), {
        timeout: 15_000,
      })
      .toContain(SMOKE_FONT)
  } finally {
    await context.close()
  }
}

test("web-state plugin serves the v1 record contract for settings.v3 and tabs", async () => {
  const server = backendURL()
  test.skip(
    !(await backendAvailable(server)),
    `${server} is unavailable; start the opencode backend on port 4096 to run this smoke`,
  )

  for (const group of ["settings.v3", "tabs"] as const) {
    const before = await getWebState(server, group)
    const updatedAt = Math.max(Date.now(), before.updated_at + 1)
    const seeded = { value: group === "tabs" ? [] : { appearance: {} }, version: "v1", updated_at: updatedAt }

    const applied = await putWebState(server, group, seeded)
    expect(applied.updated_at, `${group} accepts a newer write`).toBe(updatedAt)

    const stale = await putWebState(server, group, { value: { stale: true }, version: "v1", updated_at: updatedAt - 1 })
    expect(stale.updated_at, `${group} rejects a stale write (last-write-wins)`).toBe(updatedAt)

    await putWebState(server, group, { value: before.value, version: "v1", updated_at: updatedAt + 1 })
  }
})

test("app restores settings.v3 appearance from the server in a fresh profile", async ({ baseURL, playwright }) => {
  const server = backendURL()
  test.skip(
    !(await backendAvailable(server)),
    `${server} is unavailable; start the opencode backend on port 4096 to run this smoke`,
  )

  const previous = await getWebState(server, "settings.v3")
  const updatedAt = Math.max(Date.now(), previous.updated_at + 1)

  await putWebState(server, "settings.v3", {
    value: { appearance: { mono: SMOKE_FONT } },
    version: "v1",
    updated_at: updatedAt,
  })

  const appBrowser = await playwright.chromium.launch(launchOptions())
  try {
    await restoreFontFromServer(appBrowser, baseURL)
  } finally {
    await appBrowser.close()
    await putWebState(server, "settings.v3", { value: previous.value, version: "v1", updated_at: updatedAt + 1 })
  }
})
