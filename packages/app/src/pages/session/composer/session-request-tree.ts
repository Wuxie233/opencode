import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"

export function sessionTreeRequests<T>(
  session: ReadonlyArray<Session>,
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return []

  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    if (!list) acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID])
  const ids = [sessionID]
  for (const id of ids) {
    const list = map.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }

  return ids.flatMap((id) => request[id]?.filter(include) ?? [])
}

export function sessionPermissionRequest(
  session: ReadonlyArray<Session>,
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequests(session, request, sessionID, include)[0]
}

export function sessionQuestionRequest(
  session: ReadonlyArray<Session>,
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequests(session, request, sessionID, include)[0]
}
