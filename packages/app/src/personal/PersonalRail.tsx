import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import type {
  PersonalAttentionItem,
  PersonalProjectGroup,
  PersonalSessionItem,
  PersonalSessionState,
} from "./projection"

export function PersonalRail(props: {
  id: string
  groups: PersonalProjectGroup[]
  attention: PersonalAttentionItem[]
  dataState: "loading" | "partial" | "complete" | "error"
  search: string
  homeActive: boolean
  onSearch: (value: string) => void
  onHome: () => void
  onNewDraft: (project: PersonalProjectGroup) => void
  onToggleProject: (project: PersonalProjectGroup) => void
  onOpen: (item: PersonalSessionItem) => void
  onClose: (item: PersonalSessionItem) => void
  onArchive: (item: PersonalSessionItem) => void
  onRename: (item: PersonalSessionItem, title: string) => Promise<boolean>
  onSettings: () => void
  onMoveFocus: (event: KeyboardEvent) => void
}) {
  const language = useLanguage()
  const [renaming, setRenaming] = createSignal<string>()
  const stateLabel = (state: PersonalSessionState) => language.t(`personal.state.${state}`)
  return (
    <div class="personal-rail-content" data-personal-rail-content>
      <div class="personal-rail-heading">
        <button
          class="personal-home-button"
          type="button"
          data-active={props.homeActive ? "true" : undefined}
          aria-current={props.homeActive ? "page" : undefined}
          onClick={props.onHome}
        >
          <Icon name="workspace" />
          <span>{language.t("personal.workspace")}</span>
        </button>
        <label class="personal-search">
          <span class="sr-only">{language.t("personal.search.label")}</span>
          <Icon name="magnifying-glass" size="small" />
          <input
            type="search"
            value={props.search}
            placeholder={language.t("personal.search.placeholder")}
            onInput={(event) => props.onSearch(event.currentTarget.value)}
            onKeyDown={props.onMoveFocus}
          />
        </label>
      </div>

      <div class="personal-session-scroll">
        <Show when={props.attention.length > 0}>
          <section class="personal-blocking-section" aria-labelledby={`${props.id}-blocking-title`}>
            <h2 id={`${props.id}-blocking-title`}>{language.t("personal.blocking.title")}</h2>
            <div class="personal-blocking-list">
              <For each={props.attention}>
                {(item) => (
                  <button class="personal-blocking-button" type="button" onClick={() => props.onOpen(item.session)}>
                    <StateIcon state={item.kind} />
                    <span>
                      <strong>{item.session.title}</strong>
                      <small>{language.t(`personal.attention.${item.kind}`, { count: item.count })}</small>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={props.groups.length > 0} fallback={<EmptyState state={props.dataState} search={props.search} />}>
          <For each={props.groups}>
            {(group) => (
              <section class="personal-project-group">
                <div class="personal-project-heading">
                  <button
                    class="personal-project-toggle"
                    type="button"
                    title={group.directory}
                    aria-expanded={group.expanded}
                    onClick={() => props.onToggleProject(group)}
                  >
                    <Icon name="chevron-down" size="small" />
                    <Icon name="folder" size="small" />
                    <span>{group.name}</span>
                    <small>{group.sessions.length}</small>
                  </button>
                  <TooltipV2 placement="right" value={language.t("command.session.new")}>
                    <IconButtonV2
                      type="button"
                      size="small"
                      variant="ghost-muted"
                      class="personal-project-new"
                      icon={<Icon name="plus" />}
                      aria-label={language.t("command.session.new")}
                      onClick={() => props.onNewDraft(group)}
                    />
                  </TooltipV2>
                </div>
                <Show when={group.expanded || props.search.length > 0}>
                  <div class="personal-session-list">
                    <For each={group.sessions}>
                      {(item) => (
                        <SessionRow
                          item={item}
                          editing={renaming() === item.key}
                          stateLabel={stateLabel(item.state)}
                          onOpen={() => props.onOpen(item)}
                          onMoveFocus={props.onMoveFocus}
                          onEdit={() => setRenaming(item.key)}
                          onEditEnd={() => setRenaming(undefined)}
                          onRename={(title) => props.onRename(item, title)}
                          onClose={() => props.onClose(item)}
                          onArchive={() => props.onArchive(item)}
                        />
                      )}
                    </For>
                    <Show when={group.dataState !== "complete"}>
                      <p class="personal-project-state">
                        {group.dataState === "loading"
                          ? language.t("personal.project.loading")
                          : language.t("personal.project.partial")}
                      </p>
                    </Show>
                  </div>
                </Show>
              </section>
            )}
          </For>
          <Show when={props.dataState === "partial"}>
            <p class="personal-data-note">{language.t("personal.partial")}</p>
          </Show>
        </Show>
      </div>
      <div class="personal-rail-footer">
        <TooltipV2 placement="right" value={language.t("sidebar.settings")}>
          <IconButtonV2
            type="button"
            size="large"
            variant="ghost-muted"
            class="personal-settings-button"
            icon={<Icon name="settings-gear" />}
            aria-label={language.t("sidebar.settings")}
            title={language.t("sidebar.settings")}
            onClick={props.onSettings}
          />
        </TooltipV2>
      </div>
    </div>
  )
}

function SessionRow(props: {
  item: PersonalSessionItem
  editing: boolean
  stateLabel: string
  onOpen: () => void
  onMoveFocus: (event: KeyboardEvent) => void
  onEdit: (defer?: boolean) => void
  onEditEnd: () => void
  onRename: (title: string) => Promise<boolean>
  onClose: () => void
  onArchive: () => void
}) {
  const language = useLanguage()
  let input: HTMLInputElement | undefined
  let committing = false
  const openEdit = (defer = false) => {
    if (defer) {
      requestAnimationFrame(() => openEdit())
      return
    }
    props.onEdit()
    requestAnimationFrame(() => {
      input?.focus()
      input?.select()
    })
  }
  const closeEdit = async (save: boolean) => {
    if (committing) return
    const title = input?.value.trim() ?? ""
    if (!save || !title || title === props.item.title) {
      props.onEditEnd()
      return
    }
    committing = true
    const success = await props.onRename(title)
    committing = false
    if (success) props.onEditEnd()
    else requestAnimationFrame(() => input?.focus())
  }
  return (
    <div class="personal-session-row" data-active={props.item.active ? "true" : undefined}>
      <Show
        when={!props.editing}
        fallback={
          <div class="personal-session-editor">
            <span class="personal-session-state" data-state={props.item.state} aria-hidden="true" />
            <input
              ref={input}
              value={props.item.title}
              aria-label={language.t("common.rename")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void closeEdit(true)
                if (event.key === "Escape") void closeEdit(false)
              }}
              onBlur={() => void closeEdit(true)}
            />
          </div>
        }
      >
        <button
          class="personal-session-button"
          type="button"
          aria-current={props.item.active ? "page" : undefined}
          title={`${props.item.title} · ${props.stateLabel}`}
          onClick={(event) => {
            if (event.detail > 1) return
            props.onOpen()
          }}
          onMouseDown={(event) => {
            if (event.detail !== 2) return
            event.preventDefault()
            event.stopPropagation()
            openEdit()
          }}
          onDblClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openEdit()
          }}
          onKeyDown={props.onMoveFocus}
        >
          <span class="personal-session-state" data-state={props.item.state} aria-hidden="true" />
          <span>{props.item.title}</span>
          <small>{props.stateLabel}</small>
        </button>
      </Show>
      <SessionMenu
        item={props.item}
        onRename={() => openEdit(true)}
        onClose={props.onClose}
        onArchive={props.onArchive}
      />
    </div>
  )
}

function EmptyState(props: { state: "loading" | "partial" | "complete" | "error"; search: string }) {
  const language = useLanguage()
  return (
    <p class="personal-empty">
      {props.state === "loading"
        ? language.t("personal.loading")
        : props.state === "error"
          ? language.t("personal.error")
          : props.search
            ? language.t("personal.search.empty")
            : language.t("personal.empty")}
    </p>
  )
}

function SessionMenu(props: {
  item: PersonalSessionItem
  onRename: () => void
  onClose: () => void
  onArchive: () => void
}) {
  const language = useLanguage()
  return (
    <DropdownMenu gutter={4} placement="bottom-end">
      <DropdownMenu.Trigger
        as={IconButtonV2}
        type="button"
        size="small"
        variant="ghost-muted"
        class="personal-session-menu"
        icon={<Icon name="outline-dots" />}
        aria-label={language.t("personal.session.actions")}
        title={language.t("personal.session.actions")}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <Show when={props.item.open}>
            <DropdownMenu.Item onSelect={props.onRename}>
              <Icon name="edit" size="small" />
              <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onClose}>
              <Icon name="xmark-small" size="small" />
              <DropdownMenu.ItemLabel>{language.t("command.tab.close")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <Show when={props.item.sessionId}>
            <DropdownMenu.Item onSelect={props.onArchive}>
              <Icon name="archive" size="small" />
              <DropdownMenu.ItemLabel>{language.t("command.session.archive")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function StateIcon(props: { state: PersonalAttentionItem["kind"] }) {
  const name = () => {
    if (props.state === "question") return "help"
    if (props.state === "permission") return "status"
    if (props.state === "error") return "circle-exclamation"
    return "circle-check"
  }
  return <Icon name={name()} size="small" aria-hidden="true" />
}
