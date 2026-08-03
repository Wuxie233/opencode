## Architecture

- `PersonalLayout` is a presentation shell over the native New Layout providers and route content. Do not duplicate tabs, sessions, composer, request docks, review, files, terminal, models, providers, or MCP state here.
- `app.tsx` is the only upstream-owned selection point. Personal behavior and styles stay in this directory.

## Conventions

- Keep styles scoped below `[data-personal-ui]` and reuse v2 semantic tokens.
- Keep navigation projection pure and typed against the minimum native tab, project, session, status, and request shapes so unit tests do not load Solid Router.
- Project groups contain only native open tabs and drafts, and groups with no open entries stay out of the rail. Closed history may feed the separate blocking projection but must not appear as an open session row.
- Personal UI is the unconditional native New Layout shell. Do not add a query flag, local-storage rollout switch, or visible upstream-layout fallback.

## Commands

- `bun test src/personal/projection.test.ts`
- `bun run typecheck`
- `bun run build`
