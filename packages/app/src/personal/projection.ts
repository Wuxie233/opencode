import { pathKey } from "@/utils/path-key"

export type PersonalRoute =
  | { type: "home" }
  | { type: "draft"; draftID: string; server?: string }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: string }
  | { type: "session"; sessionId: string; server?: string }

export type PersonalTab =
  | { type: "session"; server: string; sessionId: string }
  | { type: "draft"; server: string; draftID: string; directory: string }

export type PersonalSessionSource = {
  id: string
  directory: string
  projectID?: string
  parentID?: string
  title: string
  updated: number
}

export type PersonalServerSource = {
  key: string
  name: string
  historyState: "loading" | "complete" | "error"
  projects: ReadonlyArray<{
    id?: string
    directory: string
    name: string
    expanded: boolean
    sandboxes?: ReadonlyArray<string>
    dataState: "loading" | "partial" | "complete"
  }>
  sessions: ReadonlyArray<PersonalSessionSource>
  status: Readonly<Record<string, "idle" | "retry" | "busy" | undefined>>
  questions: Readonly<Record<string, number | undefined>>
  permissions: Readonly<Record<string, number | undefined>>
}

export type PersonalTabSource = {
  key: string
  tab: PersonalTab
  title?: string
  directory?: string
}

export type PersonalSessionState = "draft" | "question" | "permission" | "retry" | "busy" | "idle" | "unknown"

export type PersonalSessionItem = {
  key: string
  server: string
  projectDirectory: string
  directory: string
  sessionId?: string
  draftID?: string
  tab?: PersonalTab
  tabKey?: string
  title: string
  updated: number
  active: boolean
  open: boolean
  state: PersonalSessionState
  runtimeState?: "idle" | "retry" | "busy"
  questionCount: number
  permissionCount: number
}

export type PersonalProjectGroup = {
  key: string
  server: string
  serverName: string
  id?: string
  directory: string
  name: string
  expanded: boolean
  dataState: "loading" | "partial" | "complete"
  sessions: PersonalSessionItem[]
}

export type PersonalBlockingItem = {
  key: string
  kind: "question" | "permission" | "retry" | "busy"
  count: number
  session: PersonalSessionItem
  project: PersonalProjectGroup
}

export type PersonalProjection = {
  state: "loading" | "partial" | "complete" | "error"
  projects: PersonalProjectGroup[]
  blocking: PersonalBlockingItem[]
}

export const PERSONAL_RECENT_SESSION_LIMIT = 12

export function personalDirectorySessionKey(directory: string, sessionID: string) {
  return `${pathKey(directory)}\0${sessionID}`
}

export function personalIdentity(server: string, directory: string, sessionID: string) {
  return `${server}\0${personalDirectorySessionKey(directory, sessionID)}`
}

export function personalProjection(input: {
  servers: ReadonlyArray<PersonalServerSource>
  tabs: ReadonlyArray<PersonalTabSource>
  route: PersonalRoute
  recentLimit?: number
}): PersonalProjection {
  const recentLimit = input.recentLimit ?? PERSONAL_RECENT_SESSION_LIMIT
  const tabsByServer = Map.groupBy(input.tabs, (item) => item.tab.server)
  const projects = input.servers.flatMap((server) =>
    projectServer(server, tabsByServer.get(server.key) ?? [], input.route, recentLimit),
  )
  const blocking = projects
    .flatMap((project) =>
      project.sessions.flatMap((session) => {
        const items: PersonalBlockingItem[] = []
        if (session.questionCount > 0)
          items.push({
            key: `question:${session.key}`,
            kind: "question",
            count: session.questionCount,
            session,
            project,
          })
        if (session.permissionCount > 0)
          items.push({
            key: `permission:${session.key}`,
            kind: "permission",
            count: session.permissionCount,
            session,
            project,
          })
        if (session.runtimeState === "retry")
          items.push({ key: `retry:${session.key}`, kind: "retry", count: 1, session, project })
        if (session.runtimeState === "busy")
          items.push({ key: `busy:${session.key}`, kind: "busy", count: 1, session, project })
        return items
      }),
    )
    .sort((a, b) => blockingRank(a.kind) - blockingRank(b.kind) || b.session.updated - a.session.updated)

  const histories = input.servers.map((server) => server.historyState)
  const directories = projects.map((project) => project.dataState)
  const state = histories.every((item) => item === "loading")
    ? "loading"
    : histories.length > 0 && histories.every((item) => item === "error")
      ? "error"
      : histories.some((item) => item !== "complete") || directories.some((item) => item !== "complete")
        ? "partial"
        : "complete"

  return { state, projects, blocking }
}

function projectServer(
  server: PersonalServerSource,
  tabs: ReadonlyArray<PersonalTabSource>,
  route: PersonalRoute,
  recentLimit: number,
) {
  const sources = new Map(server.sessions.map((session) => [session.id, session] as const))
  const claimedTabs = new Set<string>()
  const projects = server.projects.map((project) => {
    const directories = new Set([project.directory, ...(project.sandboxes ?? [])].map(pathKey))
    const projectSessions = server.sessions.filter(
      (session) =>
        directories.has(pathKey(session.directory)) ||
        (session.projectID === project.id &&
          !server.projects.some((candidate) =>
            [candidate.directory, ...(candidate.sandboxes ?? [])].map(pathKey).includes(pathKey(session.directory)),
          )),
    )
    const projectTabs = tabs.filter((item) => {
      const directory = tabDirectory(item, sources)
      if (!directory || !directories.has(pathKey(directory))) return false
      claimedTabs.add(item.key)
      return true
    })
    return makeProject(server, project, projectSessions, projectTabs, route, recentLimit)
  })

  const unclaimed = tabs.filter((item) => !claimedTabs.has(item.key))
  const fallback = Map.groupBy(unclaimed, (item) => tabDirectory(item, sources))
  for (const [directory, items] of fallback) {
    if (!directory) continue
    projects.push(
      makeProject(
        server,
        {
          directory,
          name: directory.split(/[\\/]/).filter(Boolean).at(-1) || directory,
          expanded: true,
          dataState: "loading",
        },
        [],
        items,
        route,
        recentLimit,
      ),
    )
  }
  return projects
}

function makeProject(
  server: PersonalServerSource,
  project: PersonalServerSource["projects"][number],
  sessions: ReadonlyArray<PersonalSessionSource>,
  tabs: ReadonlyArray<PersonalTabSource>,
  route: PersonalRoute,
  recentLimit: number,
): PersonalProjectGroup {
  const sessionTabs = tabs.filter((item) => item.tab.type === "session")
  const rows = new Map<string, PersonalSessionItem>()

  for (const session of sessions) {
    const tab = sessionTabs.find(
      (item) =>
        item.tab.type === "session" &&
        item.tab.sessionId === session.id &&
        (!item.directory || pathKey(item.directory) === pathKey(session.directory)),
    )
    const sessionKey = personalDirectorySessionKey(session.directory, session.id)
    const questionCount = server.questions[sessionKey] ?? 0
    const permissionCount = server.permissions[sessionKey] ?? 0
    const status = server.status[sessionKey]
    if (
      session.parentID &&
      !tab &&
      questionCount === 0 &&
      permissionCount === 0 &&
      status !== "retry" &&
      status !== "busy"
    )
      continue
    const item = sessionItem(server, project, session, tab, route)
    rows.set(item.key, item)
  }

  for (const tab of tabs) {
    if (tab.tab.type === "draft") {
      const item = draftItem(server, project, tab, route)
      rows.set(item.key, item)
      continue
    }
    const sessionTab = tab.tab
    const source = sessions.find(
      (item) =>
        item.id === sessionTab.sessionId && (!tab.directory || pathKey(tab.directory) === pathKey(item.directory)),
    )
    if (source) continue
    const directory = tabDirectory(tab, new Map(server.sessions.map((session) => [session.id, session])))
    const item = sessionItem(
      server,
      project,
      {
        id: sessionTab.sessionId,
        directory: directory || project.directory,
        title: tab.title || sessionTab.sessionId,
        updated: Number.MAX_SAFE_INTEGER,
      },
      tab,
      route,
    )
    rows.set(item.key, item)
  }

  const ordered = [...rows.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || Number(b.open) - Number(a.open) || b.updated - a.updated,
  )
  const open = ordered.filter((item) => item.open)
  const recent = ordered.filter((item) => !item.open).slice(0, recentLimit)
  return {
    key: `${server.key}\0${pathKey(project.directory)}`,
    server: server.key,
    serverName: server.name,
    id: project.id,
    directory: project.directory,
    name: project.name,
    expanded: project.expanded,
    dataState: project.dataState,
    sessions: [...open, ...recent],
  }
}

function sessionItem(
  server: PersonalServerSource,
  project: PersonalServerSource["projects"][number],
  source: PersonalSessionSource,
  tab: PersonalTabSource | undefined,
  route: PersonalRoute,
): PersonalSessionItem {
  const sessionKey = personalDirectorySessionKey(source.directory, source.id)
  const questionCount = server.questions[sessionKey] ?? 0
  const permissionCount = server.permissions[sessionKey] ?? 0
  const status = server.status[sessionKey]
  const state =
    questionCount > 0
      ? "question"
      : permissionCount > 0
        ? "permission"
        : status === "retry"
          ? "retry"
          : status === "busy"
            ? "busy"
            : project.dataState === "complete"
              ? "idle"
              : "unknown"
  const directory = tab?.directory || source.directory
  return {
    key: personalIdentity(server.key, directory, source.id),
    server: server.key,
    projectDirectory: project.directory,
    directory,
    sessionId: source.id,
    tab: tab?.tab,
    tabKey: tab?.key,
    title: tab?.title || source.title || source.id,
    updated: source.updated,
    active:
      route.type === "session" &&
      route.sessionId === source.id &&
      (route.server === undefined || route.server === server.key),
    open: !!tab,
    state,
    runtimeState: status,
    questionCount,
    permissionCount,
  }
}

function draftItem(
  server: PersonalServerSource,
  project: PersonalServerSource["projects"][number],
  tab: PersonalTabSource,
  route: PersonalRoute,
): PersonalSessionItem {
  const draft = tab.tab
  if (draft.type !== "draft") throw new Error("Expected draft tab")
  return {
    key: `${server.key}\0${pathKey(draft.directory)}\0draft:${draft.draftID}`,
    server: server.key,
    projectDirectory: project.directory,
    directory: draft.directory,
    draftID: draft.draftID,
    tab: draft,
    tabKey: tab.key,
    title: tab.title || "New session",
    updated: Number.MAX_SAFE_INTEGER,
    active:
      route.type === "draft" &&
      route.draftID === draft.draftID &&
      (route.server === undefined || route.server === server.key),
    open: true,
    state: "draft",
    runtimeState: undefined,
    questionCount: 0,
    permissionCount: 0,
  }
}

function tabDirectory(tab: PersonalTabSource, sessions: ReadonlyMap<string, PersonalSessionSource>) {
  if (tab.tab.type === "draft") return tab.tab.directory
  return tab.directory || sessions.get(tab.tab.sessionId)?.directory || ""
}

function blockingRank(kind: PersonalBlockingItem["kind"]) {
  if (kind === "question") return 0
  if (kind === "permission") return 1
  if (kind === "retry") return 2
  return 3
}
