import { describe, expect, test } from "bun:test"
import { createPairing, loadManifest, restartPageStaticText } from "./restart"

describe("RestartPage", () => {
  test("shows security scope and download links without credential inputs", async () => {
    const requests: { url: string; method?: string }[] = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method })
      if (String(input) === "/sidebar-sync/pairing") {
        return Promise.resolve(
          new Response(JSON.stringify({ code: "PAIR-1234", expiresAt: "2026-05-16T12:00:00.000Z" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: "1.2.3",
            generatedAt: "2026-05-16T11:00:00.000Z",
            artifacts: [
              { path: "opencode-sidebar-sync-extension.zip", sha256: "extension-hash" },
              { path: "opencode-sidebar-sync.user.js", sha256: "userscript-hash" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as typeof fetch

    const pairing = await createPairing()
    const manifest = await loadManifest()
    const text = restartPageStaticText()
    expect(requests).toContainEqual({ url: "/sidebar-sync/pairing", method: "POST" })
    expect(text).toContain("opened sidebar projects")
    expect(text).toContain("order")
    expect(text).toContain("expanded flags")
    expect(text).toContain("lastProject")
    expect(text).toContain("server.list")
    expect(text).toContain("passwords")
    expect(text).toContain("tokens")
    expect(text).toContain("credentials")
    expect(text).toContain("model config")
    expect(text).toContain("sessions")
    expect(text).toContain("prompts")
    expect(text).toContain("historical /project full list")
    expect(text).toContain("/restart/opencode-sidebar-sync.user.js")
    expect(text).toContain("/restart/opencode-sidebar-sync-extension.zip")
    expect(text).toContain("/restart/manifest.json")
    expect(pairing.code).toBe("PAIR-1234")
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.generatedAt).toBe("2026-05-16T11:00:00.000Z")
    expect(manifest.artifacts.map((artifact) => artifact.sha256)).toEqual(["extension-hash", "userscript-hash"])
    expect(await Bun.file("src/pages/restart.tsx").text()).not.toMatch(/<input|type=["']password["']/)
    expect(text).not.toContain("type=\"password\"")
    expect(text).not.toContain("<input")
  })

  test("shows safe failure state when pairing API and manifest are unavailable", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("unavailable", { status: 503 }))) as typeof fetch

    await expect(createPairing()).rejects.toThrow("pairing unavailable")
    await expect(loadManifest()).rejects.toThrow("manifest unavailable")
    expect(restartPageStaticText()).toContain("No credentials or tokens are requested on this page")
  })
})
