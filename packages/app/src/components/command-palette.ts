import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createLatestSearch } from "@opencode-ai/ui/hooks"
import { useNavigate } from "@solidjs/router"
import { createMemo, onCleanup } from "solid-js"
import { useCommand, type CommandOption } from "@/context/command"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import { createSessionEntries } from "./command-palette-session-load"

export type CommandPaletteEntry = {
  id: string
  type: "command" | "file" | "session"
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  archived?: number
  updated?: number
}

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

export function uniqueCommandPaletteEntries(items: CommandPaletteEntry[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export function createCommandPaletteFileEntry(path: string, category: string): CommandPaletteEntry {
  return {
    id: "file:" + path,
    type: "file",
    title: path,
    category,
    path,
  }
}

export function createCommandPaletteFileOpener(onOpenFile?: (path: string) => void) {
  const file = useFile()
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()

  return (path: string) => {
    const value = file.tab(path)
    void tabs().open(value)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    onOpenFile?.(path)
    tabs().setActive(value)
  }
}

export function createCommandPaletteModel(props: { filesOnly?: () => boolean; onOpenFile?: (path: string) => void }) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const file = useFile()
  const dialog = useDialog()
  const navigate = useNavigate()
  const serverSDK = useServerSDK()()
  const serverSync = useServerSync()
  const { params, tabs } = useSessionLayout()
  const openFile = createCommandPaletteFileOpener(props.onOpenFile)
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const filesOnly = () => props.filesOnly?.() ?? false
  const fileSearch = createLatestSearch((query, signal) => file.searchFiles(query, { signal }).catch(() => []))

  const allowedCommands = createMemo(() => {
    if (filesOnly()) return []
    return command.options.filter(
      (option) =>
        !option.disabled && !option.hidden && !option.id.startsWith("suggested.") && option.id !== "file.open",
    )
  })
  const commandEntries = createMemo(() => {
    const category = language.t("palette.group.commands")
    return allowedCommands().map((option) => createCommandEntry(option, category))
  })
  const preferredCommandEntries = createMemo(() => {
    const all = allowedCommands()
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = language.t("palette.group.commands")
    return sorted.map((option) => createCommandEntry(option, category))
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const recentFileEntries = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    const category = language.t("palette.group.files")
    return order
      .map((item) => file.pathFromTab(item))
      .filter((path): path is string => {
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
      .slice(0, ENTRY_LIMIT)
      .map((path) => createCommandPaletteFileEntry(path, category))
  })
  const rootFileEntries = createMemo(() => {
    const category = language.t("palette.group.files")
    return file.tree
      .children("")
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, ENTRY_LIMIT)
      .map((path) => createCommandPaletteFileEntry(path, category))
  })

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return undefined
    return layout.projects.list().find((item) => item.worktree === directory || item.sandboxes?.includes(directory))
  })
  const workspaces = createMemo(() => {
    const directory = projectDirectory()
    const current = project()
    if (!current) return directory ? [directory] : []
    const dirs = [current.worktree, ...(current.sandboxes ?? [])]
    if (directory && !dirs.includes(directory)) return [...dirs, directory]
    return dirs
  })
  const homedir = createMemo(() => serverSync().data.path.home)
  const sessions: (text: string) => CommandPaletteEntry[] | Promise<CommandPaletteEntry[]> = createSessionEntries({
    workspaces,
    label: (directory) => {
      const current = project()
      const kind =
        current && directory === current.worktree
          ? language.t("workspace.type.local")
          : language.t("workspace.type.sandbox")
      const [store] = serverSync().child(directory, { bootstrap: false })
      const home = homedir()
      const path = home ? directory.replace(home, "~") : directory
      const name = store.vcs?.branch ?? getFilename(directory)
      return `${kind} : ${name || path}`
    },
    load: (directory, signal) => serverSDK.client.session.list({ directory, roots: true }, { signal }),
    untitled: () => language.t("command.session.new"),
    category: () => language.t("command.category.session"),
  })
  const clearSearch = () => {
    fileSearch.stop()
    sessions("")
  }

  const highlight = (item: CommandPaletteEntry | undefined) => {
    state.cleanup?.()
    state.cleanup = undefined
    if (item?.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const select = (item: CommandPaletteEntry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()
    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }
    if (item.type === "session") {
      if (!item.directory || !item.sessionID) return
      navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
      return
    }
    if (!item.path) return
    openFile(item.path)
  }

  onCleanup(() => {
    clearSearch()
    if (state.committed) return
    state.cleanup?.()
  })

  return {
    language,
    file,
    searchFiles: fileSearch.run,
    clearSearch,
    commandEntries,
    preferredCommandEntries,
    recentFileEntries,
    rootFileEntries,
    sessions,
    highlight,
    select,
    close: () => dialog.close(),
  }
}

function createCommandEntry(option: CommandOption, category: string): CommandPaletteEntry {
  return {
    id: "command:" + option.id,
    type: "command",
    title: option.title,
    description: option.description,
    keybind: option.keybind,
    category,
    option,
  }
}
