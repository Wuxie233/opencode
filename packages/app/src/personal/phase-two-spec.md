# Personal UI Phase Two

## Goal

Make Personal UI the default native New Layout shell and turn its project rail into the primary daily navigation and blocking-work surface. Preserve native OpenCode state, actions, routes, and platform behavior.

## User Scenario

One operator moves repeatedly between several open projects and session tabs, needs to see active or blocked work quickly, and uses the same interface from desktop and mobile Web.

## In Scope

- Render `PersonalLayout` unconditionally for the upstream New Layout provider topology.
- Remove the Personal UI query/local-storage feature flag, upstream-layout command, and visible fallback button.
- Show only native persisted session tabs and drafts in project groups; use the V2 Home session-index path only to resolve metadata and global blocking work.
- Group sessions under native open projects by server and directory. Preserve server + directory + session identity for every action.
- Show native `busy`, `retry`, pending-question, pending-permission, unread-completion, and unread-error states with text/icon cues in addition to color.
- Add a compact attention section for pending questions, non-auto-respond permissions, unread completions, and unread errors. Keep running and retrying sessions under their projects.
- Add project collapse, open-session search, and active/open state.
- Add native actions for new draft, open/select session, menu and double-click rename, close an open tab, archive a session, and open Settings. Archiving closes the native tab only after the session update succeeds. Do not invent archive restore.
- Reuse `useLayout().mobileSidebar` and the native drawer primitives for a mobile navigation drawer that closes after navigation and restores focus.
- Put Personal UI copy in the app i18n dictionaries. Keep technical identifiers unchanged.
- Preserve native titlebar, Home, draft, Session, timeline, composer, request docks, review, files, terminal, models, providers, MCP, notifications, and toast behavior.

## Data Contract

- Session metadata and global blocking discovery reuse `loadHomeSessionIndex` and the per-server TanStack query caches. Do not add a second backend API or persistence store.
- Project metadata comes from `useGlobal().ensureServerCtx(conn).projects.list()`.
- Runtime status and pending requests come from the existing directory-scoped `sync.child(directory)` / `sync.session.data` state. Root attention counts include descendant requests and exclude auto-respond permissions. An unloaded directory is unknown, not idle or clear.
- Unread completion and error state comes from the native notification store and is keyed by server, directory, and session. Opening a session clears only that directory's matching notifications through native viewed semantics.
- Tabs and drafts remain owned by `useTabs()`. New sessions use `tabs.newDraft`; opening a session uses eager native tab selection so browser history and the active row update before target data, while Router popstate handling preserves leave guards and one history entry.
- Archive uses the existing directory-aware session update helper and removes the archived session from tabs and Personal projections through native events/cache updates after success.
- Cross-server identities must never be reduced to session ID alone.

## Interaction Contract

- Desktop at 1080px and above shows the persistent rail. Project groups mirror native open tabs; closed history stays on Home and global blocking work remains in the dedicated blocking section.
- Below 1080px the rail is available through a labelled 44px titlebar/menu trigger and a modal drawer. Escape, close button, and selection close it; focus returns to the trigger.
- Search is a labelled search input with keyboard navigation over visible sessions. Project collapse and search state may use app-local persisted presentation state but cannot alter native project/session data.
- Session actions use native menu semantics. Icon-only controls require an accessible name and tooltip on pointer devices.
- Attention items are deduplicated by root session and ordered question, permission, unread error, unread completion; within a category use most recently updated first.
- Session selection commits the URL and active row before target lineage or messages finish. The route surface shows a native loading state until Router data settles.
- Empty, loading, and partial-data states must be explicit and must not claim that all servers or directories are clear while data is still loading.

## Non-Goals

- No replacement session, message, tool, file, review, terminal, model, provider, MCP, permission, question, SSE, or reducer implementation.
- No new backend route, database table, global polling loop, archive undo protocol, or client-owned copy of server state.
- No complete cc-haha visual skin or copied brand assets.
- No removal of upstream New Layout source code; it remains the native behavior foundation, but it is no longer a user-selectable shell.
- No OpenCode service restart without separate explicit approval after immutable staging.

## Ownership Boundary

- Primary fork-owned implementation: `packages/app/src/personal/**`.
- Narrow integration edits are allowed in `packages/app/src/app.tsx`, the native titlebar/mobile trigger seam, and app i18n dictionaries.
- Narrow context and route changes may expose directory-aware notification viewing, eager tab selection, or archive fallback behavior. Keep those APIs native and reusable rather than creating Personal-owned persistence.

## Acceptance Evidence

- New Layout routes always render Personal UI and contain no `personal-ui` query/storage resolution, upstream-layout command, or visible fallback control.
- Persisted tabs, new drafts, open/select, close-tab, and archive actions use native contexts and keep cross-server identities correct; closed history never appears in project session lists.
- Busy/retry project indicators and question/permission/completion/error attention update from native cache/event changes without a new polling loop.
- Menu and double-click rename call the native session update API; the fixed rail footer opens native Settings on desktop and mobile.
- Successful archive closes the corresponding native tab and uses its normal adjacent/Home fallback. Failed archive leaves the tab and route intact.
- With target messages intentionally blocked, the target URL and active rail row update first; content appears after the response is released, with one history entry and working browser back navigation.
- Desktop project collapse/search/actions and mobile drawer navigation work by mouse, keyboard, and touch; focus is visible and restored after drawer close.
- Controls meet 44px mobile targets, text survives 200% zoom, there is no horizontal page overflow, and reduced-motion removes nonessential transitions.
- Personal focused tests, app browser tests, typecheck, production build, and relevant request/review/terminal/tab Playwright regressions pass.
- Browser geometry and screenshots pass at 390, 767, 1000, and 1440 widths in light/dark and reduced-motion modes.
- A single-platform binary is built into a new immutable release and smoke-tested. Live activation waits for explicit restart approval.
