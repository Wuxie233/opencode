import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  directPersonalChildren,
  hydratePersonalChildren,
  personalChildIdentity,
  personalChildProjection,
} from "./child-navigation"
import { personalChildMessages, personalChildMessagesZh, personalChildMessagesZht } from "./child-navigation-i18n"

function session(input: {
  id: string
  parentID?: string
  directory?: string
  updated?: number
  archived?: number
  title?: string
}) {
  return {
    id: input.id,
    parentID: input.parentID,
    directory: input.directory ?? "/work",
    title: input.title ?? input.id,
    time: { created: 1, updated: input.updated ?? 1, archived: input.archived },
  } as Session
}

describe("personal child navigation", () => {
  test("keeps only strict direct, non-archived children", () => {
    const root = session({ id: "root" })
    const child = session({ id: "child", parentID: "root" })
    expect(
      directPersonalChildren(root, [
        root,
        child,
        session({ id: "grandchild", parentID: "child" }),
        session({ id: "other-child", parentID: "other-root" }),
        session({ id: "other-directory", parentID: "root", directory: "/other-work" }),
        session({ id: "archived", parentID: "root", archived: 2 }),
      ]).map((item) => item.id),
    ).toEqual(["child"])
  })

  test("prioritizes request, error, and running states before recent idle children", () => {
    const root = session({ id: "root", title: "Root" })
    const projection = personalChildProjection({
      server: "server",
      root,
      sessions: [
        session({ id: "idle-new", parentID: "root", updated: 100 }),
        session({ id: "busy", parentID: "root", updated: 2 }),
        session({ id: "retry", parentID: "root", updated: 3 }),
        session({ id: "error", parentID: "root", updated: 4 }),
        session({ id: "permission", parentID: "root", updated: 5 }),
        session({ id: "question", parentID: "root", updated: 6 }),
        session({ id: "idle-old", parentID: "root", updated: 1 }),
      ],
      selectedSessionID: "busy",
      status: { busy: { type: "busy" }, retry: { type: "retry", attempt: 1, message: "retry", next: 1 } },
      questions: { question: [{}] },
      permissions: { permission: [{}] },
      errors: { error: true },
    })

    expect(projection.children.map((item) => `${item.sessionID}:${item.state}`)).toEqual([
      "question:question",
      "permission:permission",
      "error:error",
      "busy:busy",
      "retry:retry",
      "idle-new:idle",
      "idle-old:idle",
    ])
    expect(projection.selectedChild?.sessionID).toBe("busy")
  })

  test("uses server, normalized directory, and session for identity", () => {
    expect(personalChildIdentity("server-a", "/work/project/", "child")).toBe(
      personalChildIdentity("server-a", "/work/project", "child"),
    )
    expect(personalChildIdentity("server-b", "/work/project", "child")).not.toBe(
      personalChildIdentity("server-a", "/work/project", "child"),
    )
  })

  test("hydrates through the native children endpoint and remembers only accepted children", async () => {
    const calls: unknown[] = []
    const remembered: string[] = []
    const children = await hydratePersonalChildren({
      root: { id: "root", directory: "/work", workspaceID: "workspace" },
      children: async (input) => {
        calls.push(input)
        return {
          data: [
            session({ id: "child", parentID: "root" }),
            session({ id: "grandchild", parentID: "child" }),
            session({ id: "archived", parentID: "root", archived: 2 }),
          ],
        }
      },
      remember: (item) => remembered.push(item.id),
    })

    expect(calls).toEqual([{ sessionID: "root", directory: "/work", workspace: "workspace" }])
    expect(children.map((item) => item.id)).toEqual(["child"])
    expect(remembered).toEqual(["child"])
  })

  test("keeps child translation keys aligned", () => {
    expect(Object.keys(personalChildMessagesZh)).toEqual(Object.keys(personalChildMessages))
    expect(Object.keys(personalChildMessagesZht)).toEqual(Object.keys(personalChildMessages))
  })
})
