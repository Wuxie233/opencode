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
  notifications: Readonly<Record<string, { count: number; hasError: boolean } | undefined>>
}

export type PersonalTabSource = {
  key: string
  tab: PersonalTab
  title?: string
  directory?: string
}

export type PersonalSessionState =
  | "draft"
  | "question"
  | "permission"
  | "error"
  | "complete"
  | "retry"
  | "busy"
  | "idle"
  | "unknown"

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
  notificationCount: number
  notificationHasError: boolean
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

export type PersonalAttentionItem = {
  key: string
  kind: "question" | "permission" | "error" | "complete"
  count: number
  session: PersonalSessionItem
  project: PersonalProjectGroup
}

export type PersonalProjection = {
  state: "loading" | "partial" | "complete" | "error"
  projects: PersonalProjectGroup[]
  attention: PersonalAttentionItem[]
}

export type PersonalFlatOrder = "last-active" | "a-z"

export function personalDirectorySessionKey(directory: string, sessionID: string) {
  return `${pathKey(directory)}\0${sessionID}`
}

export function personalIdentity(server: string, directory: string, sessionID: string) {
  return `${server}\0${personalDirectorySessionKey(directory, sessionID)}`
}

export function personalFlatSessionOrder<T extends Pick<PersonalSessionItem, "key" | "title" | "updated">>(
  sessions: ReadonlyArray<T>,
  order: PersonalFlatOrder,
  locale: string,
): T[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true })
  return [...sessions].sort((a, b) => {
    if (order === "last-active" && a.updated !== b.updated) return b.updated - a.updated
    const title = collator.compare(a.title, b.title)
    return title || a.key.localeCompare(b.key)
  })
}

export function personalProjection(input: {
  servers: ReadonlyArray<PersonalServerSource>
  tabs: ReadonlyArray<PersonalTabSource>
  route: PersonalRoute
}): PersonalProjection {
  const tabsByServer = Map.groupBy(input.tabs, (item) => item.tab.server)
  const projected = input.servers.flatMap((server) =>
    projectServer(server, tabsByServer.get(server.key) ?? [], input.route),
  )
  const attention = projected
    .flatMap((project) =>
      project.sessions.flatMap((session) => {
        const kind = attentionKind(session)
        if (!kind) return []
        const count =
          kind === "question"
            ? session.questionCount
            : kind === "permission"
              ? session.permissionCount
              : session.notificationCount
        return [{ key: session.key, kind, count, session, project }]
      }),
    )
    .sort((a, b) => attentionRank(a.kind) - attentionRank(b.kind) || b.session.updated - a.session.updated)
  const projects = projected.flatMap((project) => {
    const sessions = project.sessions.filter((session) => session.open && !attentionKind(session))
    return sessions.length > 0 ? [{ ...project, sessions }] : []
  })

  const histories = input.servers.map((server) => server.historyState)
  const directories = projects.map((project) => project.dataState)
  const state = histories.every((item) => item === "loading")
    ? "loading"
    : histories.length > 0 && histories.every((item) => item === "error")
      ? "error"
      : histories.some((item) => item !== "complete") || directories.some((item) => item !== "complete")
        ? "partial"
        : "complete"

  return { state, projects, attention }
}

function projectServer(server: PersonalServerSource, tabs: ReadonlyArray<PersonalTabSource>, route: PersonalRoute) {
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
    return makeProject(server, project, projectSessions, projectTabs, route)
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
): PersonalProjectGroup {
  const sessionTabs = tabs.filter((item) => item.tab.type === "session")
  const rows = new Map<string, PersonalSessionItem>()
  const runtime = rootRuntimeStates(sessions, server.status)
  const attention = rootAttention(sessions, server)

  for (const session of sessions) {
    if (session.parentID) continue
    const tab = sessionTabs.find(
      (item) =>
        item.tab.type === "session" &&
        item.tab.sessionId === session.id &&
        (!item.directory || pathKey(item.directory) === pathKey(session.directory)),
    )
    const sessionKey = personalDirectorySessionKey(session.directory, session.id)
    const signals = attention.get(sessionKey)
    const questionCount = signals?.questionCount ?? 0
    const permissionCount = signals?.permissionCount ?? 0
    const status = server.status[sessionKey]
    if (
      !tab &&
      questionCount === 0 &&
      permissionCount === 0 &&
      status !== "retry" &&
      status !== "busy" &&
      !signals?.notifications.count
    )
      continue
    const item = sessionItem(server, project, session, tab, route, runtime.get(sessionKey), signals)
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
    if (source?.parentID) continue
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

  const ordered = [...rows.values()].sort((a, b) => Number(b.open) - Number(a.open) || b.updated - a.updated)
  return {
    key: `${server.key}\0${pathKey(project.directory)}`,
    server: server.key,
    serverName: server.name,
    id: project.id,
    directory: project.directory,
    name: project.name,
    expanded: project.expanded,
    dataState: project.dataState,
    sessions: ordered,
  }
}

function sessionItem(
  server: PersonalServerSource,
  project: PersonalServerSource["projects"][number],
  source: PersonalSessionSource,
  tab: PersonalTabSource | undefined,
  route: PersonalRoute,
  runtimeState?: "idle" | "retry" | "busy",
  signals?: RootSignals,
): PersonalSessionItem {
  const sessionKey = personalDirectorySessionKey(source.directory, source.id)
  const questionCount = signals?.questionCount ?? server.questions[sessionKey] ?? 0
  const permissionCount = signals?.permissionCount ?? server.permissions[sessionKey] ?? 0
  const status = runtimeState ?? server.status[sessionKey]
  const notifications = signals?.notifications ?? server.notifications[sessionKey] ?? { count: 0, hasError: false }
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
  const attention =
    questionCount > 0
      ? "question"
      : permissionCount > 0
        ? "permission"
        : notifications?.hasError
          ? "error"
          : notifications?.count
            ? "complete"
            : undefined
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
    state: attention ?? state,
    runtimeState: status,
    questionCount,
    permissionCount,
    notificationCount: notifications?.count ?? 0,
    notificationHasError: notifications?.hasError ?? false,
  }
}

type RootSignals = {
  questionCount: number
  permissionCount: number
  notifications: { count: number; hasError: boolean }
}

function rootAttention(sessions: ReadonlyArray<PersonalSessionSource>, server: PersonalServerSource) {
  const byID = new Map(
    sessions.map((session) => [personalDirectorySessionKey(session.directory, session.id), session] as const),
  )
  const roots = new Map<string, RootSignals>()
  const root = (session: PersonalSessionSource) => {
    const seen = new Set([session.id])
    let current = session
    while (current.parentID && !seen.has(current.parentID)) {
      const parent = byID.get(personalDirectorySessionKey(session.directory, current.parentID))
      if (!parent) break
      seen.add(parent.id)
      current = parent
    }
    return current
  }

  for (const session of sessions) {
    const owner = root(session)
    const key = personalDirectorySessionKey(owner.directory, owner.id)
    const sessionKey = personalDirectorySessionKey(session.directory, session.id)
    const notifications = server.notifications[sessionKey]
    const current = roots.get(key) ?? {
      questionCount: 0,
      permissionCount: 0,
      notifications: { count: 0, hasError: false },
    }
    current.questionCount += server.questions[sessionKey] ?? 0
    current.permissionCount += server.permissions[sessionKey] ?? 0
    current.notifications.count += notifications?.count ?? 0
    current.notifications.hasError ||= notifications?.hasError ?? false
    roots.set(key, current)
  }
  return roots
}

function rootRuntimeStates(sessions: ReadonlyArray<PersonalSessionSource>, status: PersonalServerSource["status"]) {
  const byID = new Map(
    sessions.map((session) => [personalDirectorySessionKey(session.directory, session.id), session] as const),
  )
  const rootByID = new Map<string, PersonalSessionSource>()

  const root = (session: PersonalSessionSource) => {
    const sessionKey = personalDirectorySessionKey(session.directory, session.id)
    const cached = rootByID.get(sessionKey)
    if (cached) return cached
    const seen = new Set([session.id])
    let current = session
    while (current.parentID) {
      if (seen.has(current.parentID)) break
      seen.add(current.parentID)
      const parent = byID.get(personalDirectorySessionKey(session.directory, current.parentID))
      if (!parent) break
      current = parent
    }
    rootByID.set(sessionKey, current)
    return current
  }

  const result = new Map<string, "idle" | "retry" | "busy">()
  for (const session of sessions) {
    const value = status[personalDirectorySessionKey(session.directory, session.id)]
    if (!value) continue
    const owner = root(session)
    const key = personalDirectorySessionKey(owner.directory, owner.id)
    const current = result.get(key)
    if (current === "busy") continue
    if (value === "busy" || value === "retry" || current === undefined) result.set(key, value)
  }
  return result
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
    updated: 0,
    active:
      route.type === "draft" &&
      route.draftID === draft.draftID &&
      (route.server === undefined || route.server === server.key),
    open: true,
    state: "draft",
    runtimeState: undefined,
    questionCount: 0,
    permissionCount: 0,
    notificationCount: 0,
    notificationHasError: false,
  }
}

function tabDirectory(tab: PersonalTabSource, sessions: ReadonlyMap<string, PersonalSessionSource>) {
  if (tab.tab.type === "draft") return tab.tab.directory
  return tab.directory || sessions.get(tab.tab.sessionId)?.directory || ""
}

function attentionKind(session: PersonalSessionItem): PersonalAttentionItem["kind"] | undefined {
  if (session.questionCount > 0) return "question"
  if (session.permissionCount > 0) return "permission"
  if (session.notificationHasError) return "error"
  if (session.notificationCount > 0) return "complete"
}

function attentionRank(kind: PersonalAttentionItem["kind"]) {
  if (kind === "question") return 0
  if (kind === "permission") return 1
  if (kind === "error") return 2
  return 3
}
