import type { LayoutRoute } from "@/context/layout"

export function titlebarRouteTitle(
  route: LayoutRoute,
  sessionTitle: string | undefined,
  labels: { home: string; newSession: string; unknown: string },
) {
  if (route.type === "home") return labels.home
  if (route.type === "draft" || route.type === "dir-new-sesssion") return labels.newSession
  return sessionTitle ?? labels.unknown
}
