# OpenCode Sidebar Sync Deployment Boundary

## Finding

The current repo defines the deployable surfaces through SST:

- `sst.config.ts` imports `infra/app.ts`, `infra/console.ts`, and `infra/enterprise.ts` from `run()`.
- `infra/app.ts` creates `api.${domain}` for `packages/function/src/api.ts`, `docs.${domain}` for `packages/web`, and `app.${domain}` for `packages/app`.
- `infra/app.ts` imports `domain` from `infra/stage.ts`; `infra/stage.ts` maps production to `opencode.ai`, dev to `dev.opencode.ai`, and other stages to `${stage}.dev.opencode.ai`.
- No existing `/restart` route was found in this worktree before planning. Current Batch 1 verification also found no `/restart` route file or route literal in the worktree; only generic restart wording exists in desktop/app i18n, tests, and permission examples.

## Minimal safe implementation path

Implement the feature without patching OpenCode behavior as the primary solution:

1. Add `/sidebar-sync/*` endpoints to the existing Worker API.
2. Add standalone browser artifacts under `packages/sidebar-sync`.
3. Add a small `/restart` route in `packages/app` that explains install/pairing and links to artifacts.
4. Do not change production DNS or restart OpenCode in this task.

## Ops follow-up

The requested public URL is `https://opencode.wuxie233.com/restart`. If deployment ownership for that domain is outside this repo, route it to the built app/static page in ops after code lands.

## Hard constraints

- Do not restart OpenCode services in this implementation batch.
- Do not change production DNS in this implementation batch.
- Treat DNS/proxy mapping for `opencode.wuxie233.com` as an ops follow-up unless the repo gains an explicit stage/domain override for that hostname.
