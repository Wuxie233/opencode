import type { Session } from "@opencode-ai/sdk/v2/client"
import { Binary } from "@opencode-ai/core/util/binary"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { Suspense, Show, createEffect, createMemo, createSignal, onCleanup, type ParentProps } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createStore, produce } from "solid-js/store"
import type { HomeSessionEvents, HomeSessionIndex } from "@/context/global-sync/home-session-index"
import { loadHomeSessionIndex, retainHomeSessions } from "@/context/global-sync/home-session-index"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { tabKey, useTabs } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { useSettingsCommand } from "@/components/settings-dialog"
import { archiveHomeSession } from "@/pages/home-session-archive"
import { sessionTreeRequests } from "@/pages/session/composer/session-request-tree"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import { sessionHref } from "@/utils/session-route"
import NewLayout from "@/pages/layout-new"
import {
  personalDirectorySessionKey,
  personalProjection,
  type PersonalProjectGroup,
  type PersonalSessionItem,
  type PersonalSessionSource,
} from "./projection"
import { PersonalRail } from "./PersonalRail"
import { PersonalChildNavigation } from "./PersonalChildNavigation"
import { personalChildProjection, hydratePersonalChildren, type PersonalChildItem } from "./child-navigation"
import { personalChildMessages, personalChildMessagesZh, personalChildMessagesZht } from "./child-navigation-i18n"
import "./personal.css"

const HISTORY_LIMIT = 64

export default function PersonalLayout(props: ParentProps) {
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const notification = useNotification()
  const permission = usePermission()
  const tabs = useTabs()
  const openSettings = useSettingsCommand()
  const compact = createMediaQuery("(max-width: 1079px)")
  const [state, setState] = createStore({ search: "", cacheVersion: 0 })
  const [pendingRoute, setPendingRoute] = createSignal<{ server: string; sessionId: string }>()
  const [childState, setChildState] = createStore<{
    key?: string
    status: "idle" | "loading" | "complete" | "error"
    root?: Session
    children: Session[]
  }>({ status: "idle", children: [] })

  const reconcilePendingRoute = () => {
    const pending = pendingRoute()
    if (!pending) return
    const href = sessionHref(ServerConnection.Key.make(pending.server), pending.sessionId)
    if (window.location.pathname !== href) setPendingRoute(undefined)
  }
  window.addEventListener("popstate", reconcilePendingRoute)
  onCleanup(() => window.removeEventListener("popstate", reconcilePendingRoute))

  createEffect(() => {
    const pending = pendingRoute()
    const route = layout.route()
    if (!pending || route.type !== "session") return
    if (route.sessionId !== pending.sessionId) return
    if (route.server !== undefined && route.server !== pending.server) return
    setPendingRoute(undefined)
  })

  function serverContext(key: string) {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
    return conn ? global.ensureServerCtx(conn) : undefined
  }

  const activeChild = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session" || !route.sessionId || route.server === undefined) return undefined
    const ctx = serverContext(route.server)
    const session = ctx?.sync.session.get(route.sessionId)
    return ctx && session ? { route, ctx, session } : undefined
  })

  createEffect(() => {
    const current = activeChild()
    if (!current) {
      setChildState({ key: undefined, status: "idle", root: undefined, children: [] })
      return
    }
    const root = current.ctx.sync.session.lineage.peek(current.session.id)?.root ?? current.session
    const key = `${current.route.server}\0${root.id}`
    if (childState.key === key && childState.status !== "error") return
    setChildState({ key, status: "loading", root, children: [] })
    void hydratePersonalChildren({
      root,
      children: (input) => current.ctx.sdk.client.session.children(input),
      remember: (item) => current.ctx.sync.session.remember(item),
    })
      .then((children) => setChildState({ key, status: "complete", root, children }))
      .catch(() => setChildState({ key, status: "error", root, children: [] }))
  })

  const childProjection = createMemo(() => {
    const root = childState.root
    const current = activeChild()
    if (!root || !current) return undefined
    return personalChildProjection({
      server: current.route.server!,
      root,
      sessions: childState.children,
      selectedSessionID: current.route.sessionId,
      status: Object.fromEntries(childState.children.map((item) => [item.id, current.ctx.sync.session.data.session_status[item.id]])),
      questions: current.ctx.sync.session.data.question,
      permissions: current.ctx.sync.session.data.permission,
    })
  })

  const childCopy = createMemo(() => {
    const source = language.locale() === "zh" ? personalChildMessagesZh : language.locale() === "zht" ? personalChildMessagesZht : personalChildMessages
    return {
      label: source["personal.children.label"],
      title: source["personal.children.title"],
      returnToRoot: source["personal.children.return"],
      loading: source["personal.children.loading"],
      error: source["personal.children.error"],
      empty: source["personal.children.empty"],
      state: {
        question: language.t("personal.state.question"),
        permission: language.t("personal.state.permission"),
        error: language.t("personal.state.error"),
        busy: language.t("personal.state.busy"),
        retry: language.t("personal.state.retry"),
        idle: language.t("personal.state.idle"),
      },
    }
  })

  function selectChild(child: PersonalChildItem) {
    const tab = tabs.addSessionTab({ server: ServerConnection.Key.make(child.server), sessionId: child.sessionID })
    setPendingRoute({ server: child.server, sessionId: child.sessionID })
    tabs.selectEager(tab)
  }

  function returnToRoot() {
    const root = childProjection()?.root
    const current = activeChild()
    if (!root || !current) return
    const tab = tabs.addSessionTab({ server: ServerConnection.Key.make(current.route.server!), sessionId: root.id })
    setPendingRoute({ server: current.route.server!, sessionId: root.id })
    tabs.selectEager(tab)
  }

  createEffect(() => {
    const cleanups = global.servers.list().map((conn) =>
      global
        .ensureServerCtx(conn)
        .queryClient.getQueryCache()
        .subscribe(() => setState("cacheVersion", (value) => value + 1)),
    )
    onCleanup(() => cleanups.forEach((cleanup) => cleanup()))
  })

  createEffect(() => {
    if (!compact() && layout.mobileSidebar.opened()) layout.mobileSidebar.hide()
  })

  createEffect(() => {
    for (const conn of global.servers.list()) {
      const ctx = global.ensureServerCtx(conn)
      const cache = ctx.sync.homeSessions
      void ctx.queryClient
        .fetchQuery({
          queryKey: cache.indexKey,
          queryFn: async ({ signal }) => {
            const eventSequence = cache.eventSequence()
            const index = await loadHomeSessionIndex(
              (input, options) => ctx.sdk.client.v2.session.list(input, options),
              eventSequence,
              signal,
            )
            cache.complete(eventSequence)
            return index
          },
          retry: false,
          staleTime: 30_000,
        })
        .catch(() => {})
    }
  })

  const projection = createMemo(() => {
    state.cacheVersion
    return personalProjection({
      servers: global.servers.list().map((conn) => {
        const key = ServerConnection.key(conn)
        const ctx = global.ensureServerCtx(conn)
        const notificationState = notification.ensureServerState(key)
        const permissionState = permission.ensureServerState(key)
        const cache = ctx.sync.homeSessions
        const query = ctx.queryClient.getQueryState(cache.indexKey)
        const index = ctx.queryClient.getQueryData<HomeSessionIndex>(cache.indexKey)
        const events = ctx.queryClient.getQueryData<HomeSessionEvents>(cache.eventsKey)
        const history = retainHomeSessions(cache.sessions(index, events), HISTORY_LIMIT, Date.now())
        const live = Object.values(ctx.sync.session.data.info).filter((session): session is Session => !!session)
        const sessions = new Map<string, Session>()
        for (const session of history) sessions.set(`${session.directory}\0${session.id}`, session)
        for (const session of live) sessions.set(`${session.directory}\0${session.id}`, session)
        const projects = ctx.projects.list()
        const directories = new Set([
          ...projects.flatMap((project) => [project.worktree, ...(project.sandboxes ?? [])]),
          ...sessions.values().map((session) => session.directory),
        ])
        const directoryStores = new Map(
          [...directories].map((directory) => [directory, ctx.sync.peek(directory, { bootstrap: false })[0]] as const),
        )
        const directorySessions = new Map(
          [...directoryStores].map(([directory, store]) => {
            const values = new Map(
              [...sessions.values(), ...store.session]
                .filter((session) => session.directory === directory)
                .map((session) => [session.id, session] as const),
            )
            return [directory, [...values.values()]] as const
          }),
        )
        return {
          key,
          name: serverName(conn),
          historyState:
            query?.status === "error" ? ("error" as const) : index ? ("complete" as const) : ("loading" as const),
          projects: projects.map((project) => ({
            id: project.id,
            directory: project.worktree,
            name: project.name || project.worktree.split(/[\\/]/).filter(Boolean).at(-1) || project.worktree,
            expanded: project.expanded,
            sandboxes: project.sandboxes,
            dataState: [project.worktree, ...(project.sandboxes ?? [])]
              .map((directory) => directoryStores.get(directory)?.status ?? "loading")
              .reduce((state, value) => {
                if (state === "loading" || value === "loading") return "loading"
                if (state === "partial" || value === "partial") return "partial"
                return "complete"
              }, "complete" as "loading" | "partial" | "complete"),
          })),
          sessions: [...sessions.values()].map(
            (session): PersonalSessionSource => ({
              id: session.id,
              directory: session.directory,
              projectID: session.projectID,
              parentID: session.parentID,
              title: session.title,
              updated: session.time.updated ?? session.time.created,
            }),
          ),
          status: Object.fromEntries(
            Object.entries(ctx.sync.session.data.session_status).flatMap(([id, value]) => {
              const session = ctx.sync.session.get(id)
              if (!session || !value) return []
              return [[personalDirectorySessionKey(session.directory, id), value.type]]
            }),
          ),
          questions: Object.fromEntries(
            [...directoryStores].flatMap(([directory, store]) =>
              (directorySessions.get(directory) ?? [])
                .filter((session) => !session.parentID)
                .map((session) => [
                  personalDirectorySessionKey(directory, session.id),
                  sessionTreeRequests(
                    directorySessions.get(directory) ?? [],
                    ctx.sync.session.data.question,
                    session.id,
                  ).length,
                ]),
            ),
          ),
          permissions: Object.fromEntries(
            [...directoryStores].flatMap(([directory, store]) =>
              (directorySessions.get(directory) ?? [])
                .filter((session) => !session.parentID)
                .map((session) => [
                  personalDirectorySessionKey(directory, session.id),
                  sessionTreeRequests(
                    directorySessions.get(directory) ?? [],
                    ctx.sync.session.data.permission,
                    session.id,
                    (item) => !permissionState.autoResponds(item, directory),
                  ).length,
                ]),
            ),
          ),
          notifications: Object.fromEntries(
            [...sessions.values()].map((session) => {
              const unseen = notificationState.session.unseenInDirectory(session.id, session.directory)
              return [
                personalDirectorySessionKey(session.directory, session.id),
                { count: unseen.length, hasError: unseen.some((item) => item.type === "error") },
              ]
            }),
          ),
        }
      }),
      tabs: tabs.store.map((tab) => {
        const key = tabKey(tab)
        return { key, tab, title: tabs.info[key]?.title, directory: tabs.info[key]?.directory }
      }),
      route: pendingRoute()
        ? { type: "session", server: pendingRoute()!.server, sessionId: pendingRoute()!.sessionId }
        : layout.route(),
    })
  })

  const groups = createMemo(() => {
    const query = state.search.trim().toLocaleLowerCase(language.intl())
    if (!query) return projection().projects
    return projection().projects.flatMap((project) => {
      const projectMatch = `${project.name} ${project.directory} ${project.serverName}`
        .toLocaleLowerCase(language.intl())
        .includes(query)
      const sessions = projectMatch
        ? project.sessions
        : project.sessions.filter((session) => session.title.toLocaleLowerCase(language.intl()).includes(query))
      return sessions.length > 0 ? [{ ...project, sessions }] : []
    })
  })

  const closeDrawer = () => layout.mobileSidebar.hide()

  function openSession(item: PersonalSessionItem) {
    if (item.tab?.type === "draft") {
      tabs.select({ ...item.tab, server: ServerConnection.Key.make(item.tab.server) })
      closeDrawer()
      return
    }
    if (!item.sessionId) return
    const ctx = serverContext(item.server)
    if (!ctx) return
    ctx.projects.open(item.projectDirectory)
    ctx.projects.touch(item.projectDirectory)
    const tab = tabs.addSessionTab({ server: ServerConnection.Key.make(item.server), sessionId: item.sessionId })
    setPendingRoute({ server: item.server, sessionId: item.sessionId })
    tabs.selectEager(tab)
    closeDrawer()
  }

  function newDraft(project: PersonalProjectGroup) {
    const ctx = serverContext(project.server)
    if (!ctx) return
    ctx.projects.open(project.directory)
    ctx.projects.touch(project.directory)
    setPendingRoute(undefined)
    void tabs.newDraft({ server: ServerConnection.Key.make(project.server), directory: project.directory })
    closeDrawer()
  }

  function closeTab(item: PersonalSessionItem) {
    if (!item.tabKey) return
    const index = tabs.store.findIndex((tab) => tabKey(tab) === item.tabKey)
    if (index !== -1) tabs.closeTab(index)
  }

  async function archiveSession(item: PersonalSessionItem) {
    if (!item.sessionId) return
    const ctx = serverContext(item.server)
    if (!ctx) return
    const [, setStore] = ctx.sync.child(item.directory)
    await archiveHomeSession({
      server: ServerConnection.Key.make(item.server),
      session: { id: item.sessionId, directory: item.directory },
      archive: (sessionID) =>
        ctx.sdk.client.session.update({ sessionID, time: { archived: Date.now() } }),
      remove: () =>
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, item.sessionId!, (session) => session.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        ),
      onError: (error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
    })
  }

  async function renameSession(item: PersonalSessionItem, title: string) {
    if (!item.sessionId) return false
    const ctx = serverContext(item.server)
    if (!ctx) return false
    return ctx.sdk
      .createClient({ directory: item.directory, throwOnError: true })
      .session.update({ sessionID: item.sessionId, title })
      .then(() => true)
      .catch((error) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
        return false
      })
  }

  function toggleProject(project: PersonalProjectGroup) {
    const ctx = serverContext(project.server)
    if (!ctx) return
    if (project.expanded) ctx.projects.collapse(project.directory)
    else ctx.projects.expand(project.directory)
  }

  function moveSessionFocus(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const rail =
      event.currentTarget instanceof Element ? event.currentTarget.closest("[data-personal-rail-content]") : null
    const items = rail ? [...rail.querySelectorAll<HTMLButtonElement>(".personal-session-button:not([disabled])")] : []
    if (items.length === 0) return
    const current = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1
    const next = event.key === "ArrowDown" ? Math.min(current + 1, items.length - 1) : Math.max(current - 1, 0)
    event.preventDefault()
    items[next]?.focus()
  }

  const rail = (id: string) => (
    <PersonalRail
      id={id}
      groups={groups()}
      attention={projection().attention}
      dataState={projection().state}
      search={state.search}
      homeActive={!pendingRoute() && layout.route().type === "home"}
      onSearch={(value) => setState("search", value)}
      onHome={() => {
        setPendingRoute(undefined)
        tabs.toggleHome({ home: false })
        closeDrawer()
      }}
      onNewDraft={newDraft}
      onToggleProject={toggleProject}
      onOpen={openSession}
      onClose={closeTab}
      onArchive={(item) => void archiveSession(item)}
      onRename={renameSession}
      onSettings={openSettings}
      onMoveFocus={moveSessionFocus}
    />
  )

  return (
    <NewLayout>
      <div data-personal-ui class="personal-shell">
        <aside class="personal-rail" aria-label={language.t("personal.navigation.label")}>
          {rail("personal-desktop")}
        </aside>

        <div class="personal-route-surface">
          <Suspense>{props.children}</Suspense>
          <Show when={pendingRoute()}>
            <div class="personal-route-loading" role="status" aria-live="polite">
              <LoaderV2 />
              <span>{language.t("personal.session.loading")}</span>
            </div>
          </Show>
        </div>

        <Show when={childProjection()}>
          {(child) => (
            <aside class="personal-child-rail" aria-label={childCopy().label}>
              <PersonalChildNavigation
                id="personal-children-desktop"
                presentation="rail"
                rootTitle={child().root.title}
                children={child().children}
                selectedChild={child().selectedChild}
                dataState={childState.status === "error" ? "error" : childState.status === "loading" ? "loading" : "complete"}
                copy={childCopy()}
                onReturnToRoot={returnToRoot}
                onSelect={selectChild}
              />
            </aside>
          )}
        </Show>

        <Drawer
          open={compact() && layout.mobileSidebar.opened()}
          onOpenChange={(open) => {
            if (open) layout.mobileSidebar.show()
            if (!open) {
              layout.mobileSidebar.hide()
              requestAnimationFrame(() => document.getElementById("personal-navigation-trigger")?.focus())
            }
          }}
          side="left"
        >
          <DrawerContent id="personal-navigation-drawer" data-personal-ui class="personal-drawer">
            <DrawerTitle class="sr-only">{language.t("personal.navigation.label")}</DrawerTitle>
            <DrawerClose
              as={IconButtonV2}
              class="personal-drawer-close"
              type="button"
              size="large"
              variant="ghost-muted"
              aria-label={language.t("personal.navigation.close")}
              title={language.t("personal.navigation.close")}
              icon={<Icon name="xmark-small" />}
            />
            {rail("personal-mobile")}
          </DrawerContent>
        </Drawer>

        <Drawer open={compact() && !!childProjection() && childProjection()!.children.length > 0} side="right" onOpenChange={() => {}}>
          <DrawerContent id="personal-children-drawer" data-personal-ui class="personal-child-drawer">
            <DrawerTitle class="sr-only">{childCopy().label}</DrawerTitle>
            <Show when={childProjection()}>
              {(child) => (
                <PersonalChildNavigation
                  id="personal-children-mobile"
                  presentation="drawer"
                  rootTitle={child().root.title}
                  children={child().children}
                  selectedChild={child().selectedChild}
                  dataState={childState.status === "error" ? "error" : childState.status === "loading" ? "loading" : "complete"}
                  copy={childCopy()}
                  onReturnToRoot={returnToRoot}
                  onSelect={selectChild}
                />
              )}
            </Show>
          </DrawerContent>
        </Drawer>
      </div>
    </NewLayout>
  )
}
