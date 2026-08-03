import { For, Show, Suspense, type ParentProps } from "solid-js"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { tabKey, useTabs } from "@/context/tabs"
import NewLayout from "@/pages/layout-new"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { personalNavigation } from "./navigation"
import { setPersonalUI } from "./flag"
import "./personal.css"

export default function PersonalLayout(props: ParentProps) {
  const command = useCommand()
  const layout = useLayout()
  const tabs = useTabs()
  const groups = () =>
    personalNavigation({
      tabs: tabs.store.map((tab) => {
        const key = tabKey(tab)
        return { key, tab, title: tabs.info[key]?.title, directory: tabs.info[key]?.directory }
      }),
      route: layout.route(),
    })

  command.register("personal-ui", () => [
    {
      id: "personal-ui.upstream",
      title: "Use upstream layout",
      category: "Personal UI",
      onSelect: () => setPersonalUI(false),
    },
  ])

  return (
    <NewLayout>
      <div data-personal-ui class="personal-shell">
        <aside class="personal-rail" aria-label="Projects and sessions">
          <div class="personal-rail-heading">
            <button
              class="personal-home-button"
              type="button"
              data-active={layout.route().type === "home" ? "true" : undefined}
              onClick={() => tabs.toggleHome({ home: false })}
            >
              <Icon name="workspace" />
              <span>Workspace</span>
            </button>
          </div>

          <div class="personal-session-scroll">
            <Show when={groups().length > 0} fallback={<p class="personal-empty">Open a session to keep it here.</p>}>
              <For each={groups()}>
                {(group) => (
                  <section class="personal-project-group">
                    <div class="personal-project-heading" title={group.directory || "Open sessions"}>
                      <Icon name="folder" size="small" />
                      <span>{group.directory.split(/[\\/]/).filter(Boolean).at(-1) || "Open sessions"}</span>
                      <small>{group.tabs.length}</small>
                    </div>
                    <div class="personal-session-list">
                      <For each={group.tabs}>
                        {(item) => (
                          <button
                            class="personal-session-button"
                            type="button"
                            data-active={item.active ? "true" : undefined}
                            aria-current={item.active ? "page" : undefined}
                            title={item.title}
                            onClick={() => tabs.select(item.tab)}
                          >
                            <span class="personal-session-state" aria-hidden="true" />
                            <span>{item.title}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>

          <button class="personal-upstream-button" type="button" onClick={() => setPersonalUI(false)}>
            <Icon name="reset" size="small" />
            <span>Use upstream layout</span>
          </button>
        </aside>

        <div class="personal-route-surface">
          <Suspense>{props.children}</Suspense>
        </div>
      </div>
    </NewLayout>
  )
}
