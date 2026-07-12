import { describe, expect, test } from "bun:test"
import { shouldReleaseDeferredRender } from "./deferred-render"

describe("shouldReleaseDeferredRender", () => {
  test("waits for the active session timeline to mount", () => {
    expect(shouldReleaseDeferredRender({ sessionID: "session", mobileChanges: false, timelineMounted: false })).toBe(
      false,
    )
    expect(shouldReleaseDeferredRender({ sessionID: "session", mobileChanges: false, timelineMounted: true })).toBe(
      true,
    )
  })

  test("releases mobile changes without waiting for the timeline", () => {
    expect(shouldReleaseDeferredRender({ sessionID: "session", mobileChanges: true, timelineMounted: false })).toBe(
      true,
    )
  })

  test("releases a new session without a timeline", () => {
    expect(shouldReleaseDeferredRender({ mobileChanges: false, timelineMounted: false })).toBe(true)
  })
})
