import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

export type PersonalChildState = "question" | "permission" | "error" | "busy" | "retry" | "idle"

export type PersonalChildItem = {
  key: string
  server: string
  directory: string
  sessionID: string
  title: string
  updated: number
  selected: boolean
  state: PersonalChildState
  questionCount: number
  permissionCount: number
}

export type PersonalChildProjection = {
  root: Pick<Session, "id" | "directory" | "title">
  children: PersonalChildItem[]
  selectedChild: PersonalChildItem | undefined
}

export function personalChildIdentity(server: string, directory: string, sessionID: string) {
  return `${server}\0${pathKey(directory)}\0${sessionID}`
}

export function directPersonalChildren(root: Pick<Session, "id" | "directory">, sessions: ReadonlyArray<Session>) {
  return sessions.filter(
    (session) => session.parentID === root.id && session.directory === root.directory && !session.time.archived,
  )
}

export function personalChildProjection(input: {
  server: string
  root: Pick<Session, "id" | "directory" | "title">
  sessions: ReadonlyArray<Session>
  selectedSessionID?: string
  status: Readonly<Record<string, SessionStatus | undefined>>
  questions: Readonly<Record<string, ReadonlyArray<unknown> | undefined>>
  permissions: Readonly<Record<string, ReadonlyArray<unknown> | undefined>>
  errors?: Readonly<Record<string, boolean | undefined>>
}): PersonalChildProjection {
  const children = directPersonalChildren(input.root, input.sessions)
    .map((session): PersonalChildItem => {
      const questionCount = input.questions[session.id]?.length ?? 0
      const permissionCount = input.permissions[session.id]?.length ?? 0
      const native = input.status[session.id]?.type ?? "idle"
      const state = questionCount
        ? "question"
        : permissionCount
          ? "permission"
          : input.errors?.[session.id]
            ? "error"
            : native
      return {
        key: personalChildIdentity(input.server, session.directory, session.id),
        server: input.server,
        directory: session.directory,
        sessionID: session.id,
        title: session.title || session.id,
        updated: session.time.updated ?? session.time.created,
        selected: session.id === input.selectedSessionID,
        state,
        questionCount,
        permissionCount,
      }
    })
    .sort(
      (a, b) =>
        personalChildStateRank(a.state) - personalChildStateRank(b.state) ||
        b.updated - a.updated ||
        a.sessionID.localeCompare(b.sessionID),
    )
  return {
    root: input.root,
    children,
    selectedChild: children.find((child) => child.selected),
  }
}

export async function hydratePersonalChildren(input: {
  root: Pick<Session, "id" | "directory" | "workspaceID">
  children: (input: {
    sessionID: string
    directory?: string
    workspace?: string
  }) => Promise<{ data?: Array<Session> | null }>
  remember?: (session: Session) => void
}) {
  const result = await input.children({
    sessionID: input.root.id,
    directory: input.root.directory,
    workspace: input.root.workspaceID,
  })
  const children = directPersonalChildren(input.root, result.data ?? [])
  children.forEach(input.remember ?? (() => {}))
  return children
}

function personalChildStateRank(state: PersonalChildState) {
  if (state === "question") return 0
  if (state === "permission") return 1
  if (state === "error") return 2
  if (state === "busy") return 3
  if (state === "retry") return 4
  return 5
}
