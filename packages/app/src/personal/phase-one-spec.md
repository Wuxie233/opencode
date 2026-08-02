# Personal UI Phase One

## Goal

Deliver a real, runtime-switchable Personal shell for the native OpenCode New Layout. It must improve daily Web navigation and workspace composition while preserving native application behavior and desktop compatibility.

## In Scope

- A fork-owned `PersonalLayout` and scoped Personal token/style layer.
- A runtime gray switch independent of the upstream `newLayoutDesigns` migration flag.
- Existing upstream New Layout remains the fallback and can be restored without a new binary.
- Compact project/session navigation and route context built from existing Layout, Tabs, Global, Server, and sync contexts.
- Native Home, draft, Session, timeline, composer, question, permission, review, files, and terminal content rendered unchanged inside the shell.
- Web-first responsive behavior with shared desktop titlebar and platform capabilities preserved.
- Focused unit coverage for flag resolution and navigation projection.
- Browser acceptance with real native data and key Home, session, request dock, review, and terminal states.

## Non-Goals

- No new backend API, persistence model, session reducer, timeline, composer, terminal, file, model, provider, MCP, permission, or question implementation.
- No direct modification of `packages/ui` primitives or v2 theme resolver in phase one.
- No copied cc-haha brand assets or complete visual skin.
- No retirement of the upstream New Layout.
- No OpenCode service restart without a separate user approval after the immutable binary is staged.

## Runtime Switch

- Query override `personal-ui=1` enables and persists Personal UI for that browser.
- Query override `personal-ui=0` disables and persists the upstream New Layout.
- Without an override, use the persisted browser preference; default to the upstream New Layout during gray rollout.
- Personal UI exposes a keyboard-accessible command to return to the upstream layout.

## Ownership Boundary

- Fork-owned implementation: `packages/app/src/personal/**` plus one small selection point in `packages/app/src/app.tsx`.
- Upstream-owned behavior: `packages/app/src/context/**`, native route providers, Home/Session implementations, timeline projection, composer controllers, request docks, review, file, terminal, settings, and `packages/ui` primitives.

## Acceptance Evidence

- Personal UI and upstream New Layout both render through the same routes and provider topology.
- Switching layouts does not remount by session ID or lose workspace-scoped terminal/file state.
- App unit/browser tests, typecheck, and production build pass; UI package checks remain clean when unaffected.
- Key existing Playwright regressions for request docks, terminal tab persistence, review/file interaction, and cross-server tabs pass.
- Browser geometry and screenshots pass at 390, 767, 1000, and 1440 widths in light/dark and reduced-motion modes.
- A single-platform binary is built into an immutable release and smoke-tested; live activation waits for explicit restart approval.
