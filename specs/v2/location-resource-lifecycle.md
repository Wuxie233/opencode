# Location Resource Lifecycle

## Goal

Prevent directory browsing and lightweight Location use from eagerly creating a long-lived FFF search runtime. Active searches keep their backend alive, while idle resources are released within a bounded time.

## Scope

- Keep `LocationServiceMap` and the existing Effect service graph.
- Create the FFF search backend lazily on the first `find`, `glob`, or `grep` operation.
- Reuse one backend for concurrent and repeated operations in the same Location.
- Keep a borrowed backend alive for the full operation and release it after 10 minutes without borrowers.
- Fall back to the ripgrep search implementation when FFF is disabled, unavailable, or fails to initialize.
- Release idle `LocationServiceMap` entries after 15 minutes instead of 60 minutes.
- Log privacy-safe FFF initialization, fallback, and disposal lifecycle events without directory or native error details.

## Non-Goals

- No watcher or LSP lifecycle redesign.
- No capacity LRU, memory-pressure eviction, cross-Location sharing, or general resource scheduler.
- No public API, database, configuration, or generated-code changes.

## Acceptance Evidence

1. Constructing a Location filesystem service without a search operation does not initialize FFF.
2. Concurrent and repeated search operations reuse a single initialized backend.
3. The backend is not disposed while an operation holds it and is disposed after the idle TTL or enclosing Location scope closes.
4. FFF initialization failure executes the requested operation through ripgrep rather than returning empty results.
5. The Location map uses a 15-minute idle TTL.
6. Focused lifecycle tests and `bun typecheck` in `packages/core` pass.

## Constraints

- Preserve `OPENCODE_DISABLE_FFF` as an immediate fallback switch.
- Preserve search result schemas and caller-facing behavior.
- Do not restart the running OpenCode service during delivery.
