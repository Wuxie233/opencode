# Personal UI Design System

## Theme

The physical scene is a low-light work screen used for long, repeated sessions. Use the existing OpenCode theme and icon assets with quieter surface separation, higher information density, and clear operational hierarchy. Light, dark, and system schemes remain native capabilities.

## Color

Reuse OpenCode v2 semantic tokens. Accent is reserved for selection, focus, primary actions, and live state. Neutral surface steps separate navigation, conversation, and contextual tools. Success, warning, retry, permission, and error states retain their native semantic colors and labels.

## Typography

Use the existing Inter and monospace assets. Use fixed product-interface sizes with clear weight contrast. Session titles wrap or truncate according to available navigation width; message content remains readable and is never viewport-scaled.

## Layout

Desktop uses a persistent operational shell: compact global/session navigation, a flexible native route surface, and native review, files, activity, or terminal context where the session exposes it. Existing Home and Session route content remains native and is composed inside the Personal shell rather than reimplemented.

At tablet and mobile widths, persistent side regions collapse into the existing native navigation and panel mechanisms. The conversation and composer remain the primary surface, safe areas are preserved, and there is no horizontal page scrolling.

## Components

- Reuse `@opencode-ai/ui` v2 primitives and native app controllers.
- Personal components live under `packages/app/src/personal/` and accept native context data rather than creating another store.
- The shell owns composition, scoped tokens, and presentation only.
- Questions, permissions, composer docks, message timeline, review, file tree, terminal, tabs, settings, models, providers, and MCP retain their native behavior implementations.
- Personal UI is the native New Layout presentation; no duplicate fallback control is shown in the workspace.
- Keep Settings in a fixed rail footer. Session rename uses a compact inline input opened from the actions menu or desktop double-click.
- Attention rows move actionable requests and unread terminal outcomes out of project groups. Running and retrying rows stay in project context.

## Motion

Use native feedback transitions only. No page-load choreography or decorative reveals. Respect the existing reduced-motion behavior and ensure content is visible before transitions.

## Responsive Behavior

Verify at 390x844, 767x900, 1000x700, and 1440x900, plus 200% browser zoom. Preserve macOS, Windows, and Linux titlebar safety. Mobile actions retain at least 44px targets and all text and controls stay within their containers.
