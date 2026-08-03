export type PersonalTab =
  | { type: "session"; server: string; sessionId: string }
  | { type: "draft"; server: string; draftID: string; directory: string }

type PersonalRoute =
  | { type: "home" }
  | { type: "draft"; draftID: string; server?: string }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: string }
  | { type: "session"; sessionId: string; server?: string }

export type PersonalNavigationGroup<T extends PersonalTab = PersonalTab> = {
  directory: string
  tabs: Array<{ key: string; tab: T; title: string; active: boolean }>
}

export function personalNavigation<T extends PersonalTab>(input: {
  tabs: ReadonlyArray<{ key: string; tab: T; title?: string; directory?: string }>
  route: PersonalRoute
}) {
  return input.tabs.reduce<PersonalNavigationGroup<T>[]>((groups, inputTab) => {
    const tab = inputTab.tab
    const directory = tab.type === "draft" ? tab.directory : (inputTab.directory ?? "")
    const group = groups.find((item) => item.directory === directory)
    const item = {
      key: inputTab.key,
      tab,
      title: inputTab.title || (tab.type === "draft" ? "New session" : tab.sessionId),
      active:
        tab.type === "draft"
          ? input.route.type === "draft" && input.route.draftID === tab.draftID
          : input.route.type === "session" &&
            input.route.sessionId === tab.sessionId &&
            (input.route.server === undefined || input.route.server === tab.server),
    }
    if (group) group.tabs.push(item)
    else groups.push({ directory, tabs: [item] })
    return groups
  }, [])
}
