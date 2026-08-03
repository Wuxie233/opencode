import { describe, expect, test } from "bun:test"
import {
  personalDirectorySessionKey,
  personalIdentity,
  personalProjection,
  type PersonalServerSource,
  type PersonalTabSource,
} from "./projection"

const serverA = "http://localhost:4096"
const serverB = "https://remote.example"

function source(patch: Partial<PersonalServerSource> = {}): PersonalServerSource {
  return {
    key: serverA,
    name: "Local",
    historyState: "complete",
    projects: [
      {
        id: "project-a",
        directory: "/work/app",
        name: "App",
        expanded: true,
        dataState: "complete",
      },
    ],
    sessions: [{ id: "ses_1", directory: "/work/app", projectID: "project-a", title: "History title", updated: 10 }],
    status: {},
    questions: {},
    permissions: {},
    ...patch,
  }
}

describe("personalProjection", () => {
  test("keeps server and directory identity while preferring an open tab", () => {
    const tabs: PersonalTabSource[] = [
      {
        key: "tab-a",
        tab: { type: "session", server: serverA, sessionId: "ses_1" },
        directory: "/work/app",
        title: "Open title",
      },
      {
        key: "tab-b",
        tab: { type: "session", server: serverB, sessionId: "ses_1" },
        directory: "/remote/app",
        title: "Remote title",
      },
    ]
    const result = personalProjection({
      servers: [
        source(),
        source({
          key: serverB,
          name: "Remote",
          projects: [
            { id: "project-b", directory: "/remote/app", name: "Remote app", expanded: true, dataState: "complete" },
          ],
          sessions: [
            { id: "ses_1", directory: "/remote/app", projectID: "project-b", title: "Remote history", updated: 9 },
          ],
        }),
      ],
      tabs,
      route: { type: "session", server: serverB, sessionId: "ses_1" },
    })

    expect(result.projects).toHaveLength(2)
    expect(result.projects[0]?.sessions[0]).toMatchObject({
      key: personalIdentity(serverA, "/work/app", "ses_1"),
      title: "Open title",
      open: true,
      active: false,
    })
    expect(result.projects[1]?.sessions[0]).toMatchObject({
      key: personalIdentity(serverB, "/remote/app", "ses_1"),
      title: "Remote title",
      active: true,
    })
  })

  test("keeps same-server session IDs separate across directories", () => {
    const result = personalProjection({
      servers: [
        source({
          projects: [
            { id: "project-a", directory: "/work/app", name: "App", expanded: true, dataState: "complete" },
            { id: "project-b", directory: "/work/api", name: "API", expanded: true, dataState: "complete" },
          ],
          sessions: [
            { id: "ses_1", directory: "/work/app", projectID: "project-a", title: "App session", updated: 10 },
            { id: "ses_1", directory: "/work/api", projectID: "project-b", title: "API session", updated: 9 },
          ],
        }),
      ],
      tabs: [
        { key: "app-tab", tab: { type: "session", server: serverA, sessionId: "ses_1" }, directory: "/work/app" },
        { key: "api-tab", tab: { type: "session", server: serverA, sessionId: "ses_1" }, directory: "/work/api" },
      ],
      route: { type: "home" },
    })

    expect(result.projects.flatMap((project) => project.sessions.map((session) => session.key))).toEqual([
      personalIdentity(serverA, "/work/app", "ses_1"),
      personalIdentity(serverA, "/work/api", "ses_1"),
    ])
  })

  test("orders blocking work and does not call unloaded directories idle", () => {
    const result = personalProjection({
      servers: [
        source({
          projects: [{ id: "project-a", directory: "/work/app", name: "App", expanded: true, dataState: "loading" }],
          sessions: [
            { id: "busy", directory: "/work/app", title: "Busy", updated: 40 },
            { id: "retry", directory: "/work/app", title: "Retry", updated: 30 },
            { id: "permission", directory: "/work/app", title: "Permission", updated: 20 },
            { id: "question", directory: "/work/app", title: "Question", updated: 10 },
            { id: "unknown", directory: "/work/app", title: "Unknown", updated: 0 },
          ],
          status: {
            [personalDirectorySessionKey("/work/app", "busy")]: "busy",
            [personalDirectorySessionKey("/work/app", "retry")]: "retry",
          },
          permissions: { [personalDirectorySessionKey("/work/app", "permission")]: 1 },
          questions: { [personalDirectorySessionKey("/work/app", "question")]: 2 },
        }),
      ],
      tabs: [
        { key: "unknown-tab", tab: { type: "session", server: serverA, sessionId: "unknown" }, directory: "/work/app" },
      ],
      route: { type: "home" },
    })

    expect(result.state).toBe("partial")
    expect(result.blocking.map((item) => item.kind)).toEqual(["question", "permission", "retry", "busy"])
    expect(result.projects[0]?.sessions.find((item) => item.sessionId === "unknown")?.state).toBe("unknown")
  })

  test("keeps runtime blockers when a question is also pending", () => {
    const result = personalProjection({
      servers: [
        source({
          sessions: [{ id: "ses_1", directory: "/work/app", title: "Blocked", updated: 10 }],
          status: { [personalDirectorySessionKey("/work/app", "ses_1")]: "retry" },
          questions: { [personalDirectorySessionKey("/work/app", "ses_1")]: 1 },
        }),
      ],
      tabs: [],
      route: { type: "home" },
    })

    expect(result.blocking.map((item) => item.kind)).toEqual(["question", "retry"])
  })

  test("shows only open tabs in project groups while retaining closed blockers", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      id: `ses_${index}`,
      directory: "/work/app",
      title: `Session ${index}`,
      updated: index,
    }))
    const tabs: PersonalTabSource[] = sessions.slice(0, 2).map((session) => ({
      key: `tab:${session.id}`,
      tab: { type: "session", server: serverA, sessionId: session.id },
      directory: session.directory,
    }))
    const result = personalProjection({
      servers: [source({
        sessions,
        questions: { [personalDirectorySessionKey("/work/app", "ses_5")]: 1 },
      })],
      tabs,
      route: { type: "home" },
    })

    expect(result.projects[0]?.sessions.map((item) => item.sessionId)).toEqual(["ses_1", "ses_0"])
    expect(result.blocking.map((item) => [item.kind, item.session.sessionId])).toEqual([["question", "ses_5"]])
  })

  test("hides project groups without open tabs", () => {
    const result = personalProjection({
      servers: [source()],
      tabs: [],
      route: { type: "home" },
    })

    expect(result.projects).toEqual([])
  })

  test("isolates status and pending work for duplicate session IDs across directories", () => {
    const result = personalProjection({
      servers: [
        source({
          projects: [
            { id: "project-a", directory: "/work/app", name: "App", expanded: true, dataState: "complete" },
            { id: "project-b", directory: "/work/api", name: "API", expanded: true, dataState: "complete" },
          ],
          sessions: [
            { id: "ses_1", directory: "/work/app", projectID: "project-a", title: "App session", updated: 10 },
            { id: "ses_1", directory: "/work/api", projectID: "project-b", title: "API session", updated: 9 },
          ],
          status: { [personalDirectorySessionKey("/work/app", "ses_1")]: "busy" },
          questions: { [personalDirectorySessionKey("/work/api", "ses_1")]: 1 },
        }),
      ],
      tabs: [
        { key: "app-tab", tab: { type: "session", server: serverA, sessionId: "ses_1" }, directory: "/work/app" },
        { key: "api-tab", tab: { type: "session", server: serverA, sessionId: "ses_1" }, directory: "/work/api" },
      ],
      route: { type: "home" },
    })

    expect(result.projects[0]?.sessions[0]).toMatchObject({ state: "busy", questionCount: 0 })
    expect(result.projects[1]?.sessions[0]).toMatchObject({ state: "question", questionCount: 1 })
    expect(result.blocking.map((item) => [item.kind, item.project.directory])).toEqual([
      ["question", "/work/api"],
      ["busy", "/work/app"],
    ])
  })
})
