import { describe, expect, test } from "bun:test"
import { titlebarRouteTitle } from "./titlebar-personal"

const labels = {
  home: "Home",
  newSession: "New session",
  unknown: "Unknown session",
}

describe("titlebarRouteTitle", () => {
  test("uses the home title for the home route", () => {
    expect(titlebarRouteTitle({ type: "home" }, "Current session", labels)).toBe("Home")
  })

  test("uses the new-session title for drafts and new sessions", () => {
    expect(titlebarRouteTitle({ type: "draft", draftID: "draft" }, undefined, labels)).toBe("New session")
    expect(
      titlebarRouteTitle({ type: "dir-new-sesssion", dir: "/repo", dirBase64: "cmVw" }, undefined, labels),
    ).toBe("New session")
  })

  test("uses the current session title and falls back when it is unavailable", () => {
    expect(titlebarRouteTitle({ type: "session", sessionId: "session" }, "Build status", labels)).toBe("Build status")
    expect(titlebarRouteTitle({ type: "session", sessionId: "session" }, undefined, labels)).toBe("Unknown session")
  })
})
