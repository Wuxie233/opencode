import { describe, expect, test } from "bun:test"
import { personalNavigation, type PersonalTab } from "./navigation"

const server = "http://localhost:4096"

describe("personalNavigation", () => {
  test("groups native tabs by workspace and marks the active route", () => {
    const session = { type: "session" as const, server, sessionId: "ses_1" }
    const draft = { type: "draft" as const, server, draftID: "draft_1", directory: "/work/app" }
    const tabs: Array<{ key: string; tab: PersonalTab; title?: string; directory?: string }> = [
      { key: "session:1", tab: session, title: "Fix navigation", directory: "/work/app" },
      { key: "draft:1", tab: draft },
    ]
    const result = personalNavigation({
      tabs,
      route: { type: "session", server, sessionId: "ses_1" },
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.directory).toBe("/work/app")
    expect(result[0]?.tabs.map((item) => [item.title, item.active])).toEqual([
      ["Fix navigation", true],
      ["New session", false],
    ])
  })
})
