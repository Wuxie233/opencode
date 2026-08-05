## Architecture

- `PersonalLayout` is a presentation shell over the native New Layout providers and route content. Do not duplicate tabs, sessions, composer, request docks, review, files, terminal, models, providers, or MCP state here.
- `app.tsx` is the only upstream-owned selection point. Personal behavior and styles stay in this directory.

## Conventions

- Keep styles scoped below `[data-personal-ui]` and reuse v2 semantic tokens.
- Keep navigation projection pure and typed against the minimum native tab, project, session, status, and request shapes so unit tests do not load Solid Router.
- Project groups contain only native open tabs and drafts, and groups with no open entries stay out of the rail. Closed history may feed the separate blocking projection but must not appear as an open session row.
- Attention contains one entry per root session. Pending question and non-auto-respond permission requests are aggregated across descendants; unread completion and error notifications are scoped by server, directory, and session. Busy and retry states stay in project groups.
- Read runtime status and pending requests from the server-level `sync.session` store because passive directory stores skip session-content events. Project each descendant's runtime state onto its root with `busy > retry > idle` precedence.
- Personal session selection uses the native tab store with eager browser history so the URL and active row commit before target data. Keep the Router popstate path, one history entry, `useBeforeLeave` handling, and a loading overlay intact.
- Archive remains success-gated: the native session update must succeed before the native tab-removal event closes the tab and selects its existing fallback. Rename and Settings reuse their native API and dialog.
- Personal UI is the unconditional native New Layout shell. Do not add a query flag, local-storage rollout switch, or visible upstream-layout fallback.

## Commands

- `bun test src/personal/projection.test.ts`
- `bun run typecheck`
- `bun run build`
