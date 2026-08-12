import { Icon } from "@opencode-ai/ui/v2/icon"
import { For, Match, Show, Switch } from "solid-js"
import type { PersonalChildItem, PersonalChildState } from "./child-navigation"
import "./personal-child-navigation.css"

export type PersonalChildNavigationCopy = {
  label: string
  title: string
  returnToRoot: string
  loading: string
  error: string
  empty: string
  state: Readonly<Record<PersonalChildState, string>>
}

export function PersonalChildNavigation(props: {
  id: string
  presentation: "rail" | "drawer"
  rootTitle: string
  children: ReadonlyArray<PersonalChildItem>
  selectedChild?: PersonalChildItem
  dataState: "loading" | "complete" | "error"
  copy: PersonalChildNavigationCopy
  onReturnToRoot: () => void
  onSelect: (child: PersonalChildItem) => void
}) {
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    const navigation =
      event.currentTarget instanceof Element
        ? event.currentTarget.closest<HTMLElement>("[data-personal-child-navigation]")
        : undefined
    const buttons = navigation
      ? [...navigation.querySelectorAll<HTMLButtonElement>("[data-personal-child-action]:not([disabled])")]
      : []
    if (!buttons.length) return
    const current = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? Math.min(current + 1, buttons.length - 1)
            : Math.max(current - 1, 0)
    event.preventDefault()
    buttons[index]?.focus()
  }

  return (
    <nav
      id={props.id}
      data-personal-child-navigation
      data-presentation={props.presentation}
      aria-label={props.copy.label}
    >
      <header class="personal-child-header">
        <div>
          <h2>{props.copy.title}</h2>
          <p title={props.rootTitle}>{props.rootTitle}</p>
        </div>
        <Show when={props.selectedChild}>
          <button
            type="button"
            class="personal-child-return"
            data-personal-child-action
            onClick={props.onReturnToRoot}
            onKeyDown={moveFocus}
          >
            <Icon name="reset" size="small" />
            <span>{props.copy.returnToRoot}</span>
          </button>
        </Show>
      </header>

      <Switch>
        <Match when={props.dataState === "loading"}>
          <p class="personal-child-state" role="status" aria-live="polite">
            {props.copy.loading}
          </p>
        </Match>
        <Match when={props.dataState === "error"}>
          <p class="personal-child-state" role="alert">
            {props.copy.error}
          </p>
        </Match>
        <Match when={props.children.length === 0}>
          <p class="personal-child-state">{props.copy.empty}</p>
        </Match>
        <Match when={true}>
          <div class="personal-child-list">
            <For each={props.children}>
              {(child) => (
                <button
                  type="button"
                  class="personal-child-row"
                  data-personal-child-action
                  data-state={child.state}
                  data-selected={child.selected ? "true" : undefined}
                  aria-current={child.selected ? "page" : undefined}
                  aria-label={`${child.title}, ${props.copy.state[child.state]}`}
                  onClick={() => props.onSelect(child)}
                  onKeyDown={moveFocus}
                >
                  <span class="personal-child-indicator" aria-hidden="true" />
                  <span class="personal-child-copy">
                    <strong>{child.title}</strong>
                    <small>{props.copy.state[child.state]}</small>
                  </span>
                  <Icon name="outline-chevron-down" size="small" class="personal-child-next" />
                </button>
              )}
            </For>
          </div>
        </Match>
      </Switch>
    </nav>
  )
}
