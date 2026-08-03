## Architecture

- `PersonalLayout` is a presentation shell over the native New Layout providers and route content. Do not duplicate tabs, sessions, composer, request docks, review, files, terminal, models, providers, or MCP state here.
- `app.tsx` is the only upstream-owned selection point. Personal behavior and styles stay in this directory.

## Conventions

- Keep styles scoped below `[data-personal-ui]` and reuse v2 semantic tokens.
- Keep navigation projection pure and typed against the minimum native tab shape so unit tests do not load Solid Router.
- Preserve the runtime fallback: `personal-ui=1` enables and persists Personal UI; `personal-ui=0` restores the upstream New Layout.

## Commands

- `bun test src/personal/flag.test.ts src/personal/navigation.test.ts`
- `bun run typecheck`
- `bun run build`
