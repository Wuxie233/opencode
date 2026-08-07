import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/AttachmentUpload"
const projectID = "proj_attachment_upload"
const sessionID = "ses_attachment_upload"

async function setup(page: Page) {
  let patchAttempts = 0
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "attachment-upload",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "attachment-upload",
        projectID,
        directory,
        title: "Attachment upload",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/attachment**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "POST" && url.pathname === "/api/attachment")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ attachmentID: "att_browser", offset: 0, state: "uploading" }),
      })
    if (request.method() === "PATCH") {
      if (patchAttempts++ === 0) return route.abort("failed")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ offset: request.postDataBuffer()?.byteLength ?? 0 }),
      })
    }
    if (request.method() === "POST" && url.pathname.endsWith("/complete"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: "/private/opencode/attachments/archive.bin",
          filename: "archive.bin",
          mime: "application/octet-stream",
          size: 4,
        }),
      })
    if (request.method() === "GET" && url.pathname.endsWith("/content"))
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: "data" })
    return route.fulfill({ status: 204 })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  return () => patchAttempts
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`uploads and presents an arbitrary attachment on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const patchAttempts = await setup(page)
    const composer = page.locator('[data-component="prompt-input-v2"]')
    await expectAppVisible(composer)
    const dismiss = page.getByRole("button", { name: "Dismiss Tabs information" })
    if (await dismiss.isVisible()) await dismiss.click()

    await page.locator('input[type="file"]').setInputFiles({
      name: "archive.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([1, 2, 3, 4]),
    })

    const card = composer.locator('[data-component="attachment-card-v2"]', { hasText: "archive.bin" })
    await expect(card).toBeVisible()
    await card.hover()
    await expect(composer.getByRole("button", { name: "Download attachment" })).toBeVisible()
    await expect(composer.getByRole("button", { name: "Remove attachment" })).toBeVisible()
    expect(patchAttempts()).toBe(2)

    const composerBox = await composer.boundingBox()
    const cardBox = await card.boundingBox()
    expect(composerBox).not.toBeNull()
    expect(cardBox).not.toBeNull()
    expect(composerBox!.x).toBeGreaterThanOrEqual(0)
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(viewport.width)
    expect(cardBox!.x).toBeGreaterThanOrEqual(composerBox!.x)
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width)
  })
}

test("keeps image previews working after upload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)

  await page.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  })

  await expect(composer.getByRole("img", { name: "pixel.png" })).toBeVisible()
  await expect(composer.getByRole("button", { name: "Download attachment" })).toBeAttached()
})

test("disables attachment entrance motion when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)

  await page.locator('input[type="file"]').setInputFiles({
    name: "reduced.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([1, 2, 3, 4]),
  })

  const attachment = composer.locator(".prompt-attachment-enter", { hasText: "reduced.bin" })
  await expect(attachment).toBeVisible()
  await expect(attachment).toHaveCSS("animation-name", "none")
})
