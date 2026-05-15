import { describe, expect, test } from "bun:test"
import { extractSidebarPayload, mergeSidebarPayload, parsePersistedServer } from "./persisted-store"

describe("persisted sidebar store helpers", () => {
  test("extracts only projects and lastProject for one scope", () => {
    expect(
      extractSidebarPayload(
        {
          projects: {
            local: [
              { worktree: "/repo/local", expanded: true, token: "secret" },
              { worktree: "/repo/other", expanded: false },
            ],
            remote: [{ worktree: "/repo/remote", expanded: true }],
          },
          lastProject: {
            local: "/repo/local",
            remote: "/repo/remote",
          },
          list: ["http://localhost:4096"],
          provider_auth: { token: "secret" },
          config: { model: "secret" },
          session: { current: "secret" },
          prompt: "secret",
          credentials: "secret",
        },
        "local",
      ),
    ).toEqual({
      schemaVersion: 1,
      projects: [
        { worktree: "/repo/local", expanded: true },
        { worktree: "/repo/other", expanded: false },
      ],
      lastProject: "/repo/local",
    })
  })

  test("preserves unrelated current data when merging", () => {
    expect(
      mergeSidebarPayload(
        {
          projects: {
            remote: [{ worktree: "/repo/remote", expanded: true }],
            local: [{ worktree: "/repo/stale", expanded: false }],
          },
          lastProject: {
            remote: "/repo/remote",
            local: "/repo/stale",
          },
          list: ["http://localhost:4096"],
          provider_auth: { token: "secret" },
        },
        "local",
        {
          schemaVersion: 1,
          projects: [{ worktree: "/repo/local", expanded: true }],
          lastProject: "/repo/local",
        },
      ),
    ).toEqual({
      projects: {
        remote: [{ worktree: "/repo/remote", expanded: true }],
        local: [{ worktree: "/repo/local", expanded: true }],
      },
      lastProject: {
        remote: "/repo/remote",
        local: "/repo/local",
      },
      list: ["http://localhost:4096"],
      provider_auth: { token: "secret" },
    })
  })

  test("removes scoped lastProject when payload omits it", () => {
    expect(
      mergeSidebarPayload(
        {
          projects: { local: [{ worktree: "/repo/stale", expanded: false }] },
          lastProject: { local: "/repo/stale", remote: "/repo/remote" },
        },
        "local",
        { schemaVersion: 1, projects: [{ worktree: "/repo/local", expanded: true }] },
      ),
    ).toEqual({
      projects: { local: [{ worktree: "/repo/local", expanded: true }] },
      lastProject: { remote: "/repo/remote" },
    })
  })

  test("returns undefined for damaged JSON", () => {
    expect(parsePersistedServer("{broken")).toBeUndefined()
    expect(parsePersistedServer(null)).toBeUndefined()
  })
})
