import type { Session } from "@opencode-ai/sdk/v2/client"
import { Binary } from "@opencode-ai/core/util/binary"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Suspense, createEffect, createMemo, onCleanup, startTransition, type ParentProps } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createStore, produce } from "solid-js/store"
import type { HomeSessionEvents, HomeSessionIndex } from "@/context/global-sync/home-session-index"
import { loadHomeSessionIndex, retainHomeSessions } from "@/context/global-sync/home-session-index"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { tabKey, useTabs } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { archiveHomeSession } from "@/pages/home-session-archive"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import NewLayout from "@/pages/layout-new"
import {
  personalDirectorySessionKey,
  personalProjection,
  type PersonalProjectGroup,
  type PersonalSessionItem,
  type PersonalSessionSource,
} from "./projection"
import { PersonalRail } from "./PersonalRail"
import "./personal.css"

const HISTORY_LIMIT = 64

export default function PersonalLayout(props: ParentProps) {
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const compact = createMediaQuery("(max-width: 1079px)")
  const [state, setState] = createStore({ search: "", cacheVersion: 0 })

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
            [...directoryStores].flatMap(([directory, store]) =>
              Object.entries(store.session_status).map(([id, value]) => [
                personalDirectorySessionKey(directory, id),
                value?.type,
              ]),
            ),
          ),
          questions: Object.fromEntries(
            [...directoryStores].flatMap(([directory, store]) =>
              Object.entries(store.question).map(([id, value]) => [
                personalDirectorySessionKey(directory, id),
                value?.length ?? 0,
              ]),
            ),
          ),
          permissions: Object.fromEntries(
            [...directoryStores].flatMap(([directory, store]) =>
              Object.entries(store.permission).map(([id, value]) => [
                personalDirectorySessionKey(directory, id),
                value?.length ?? 0,
              ]),
            ),
          ),
        }
      }),
      tabs: tabs.store.map((tab) => {
        const key = tabKey(tab)
        return { key, tab, title: tabs.info[key]?.title, directory: tabs.info[key]?.directory }
      }),
      route: layout.route(),
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

  function serverContext(key: string) {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
    return conn ? global.ensureServerCtx(conn) : undefined
  }

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
    startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.Key.make(item.server), sessionId: item.sessionId! })
      tabs.select(tab)
    })
    closeDrawer()
  }

  function newDraft(project: PersonalProjectGroup) {
    const ctx = serverContext(project.server)
    if (!ctx) return
    ctx.projects.open(project.directory)
    ctx.projects.touch(project.directory)
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
      update: (value) => ctx.sdk.client.session.update(value),
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
      blocking={projection().blocking}
      dataState={projection().state}
      search={state.search}
      homeActive={layout.route().type === "home"}
      onSearch={(value) => setState("search", value)}
      onHome={() => {
        tabs.toggleHome({ home: false })
        closeDrawer()
      }}
      onNewDraft={newDraft}
      onToggleProject={toggleProject}
      onOpen={openSession}
      onClose={closeTab}
      onArchive={(item) => void archiveSession(item)}
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
        </div>

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
      </div>
    </NewLayout>
  )
}
