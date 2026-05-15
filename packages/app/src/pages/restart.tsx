import { createResource, For, Match, Switch } from "solid-js"

interface PairingCreatedResponse {
  readonly code: string
  readonly expiresAt: string
}

interface ReleaseArtifact {
  readonly path: string
  readonly sha256: string
}

interface ReleaseManifest {
  readonly version: string
  readonly generatedAt: string
  readonly artifacts: readonly ReleaseArtifact[]
}

const links = [
  {
    href: "/restart/opencode-sidebar-sync-extension.zip",
    label: "Chrome / Edge extension zip",
    description: "Recommended for Chrome and Edge. Download, unzip, then load the unpacked extension from the browser extensions page.",
  },
  {
    href: "/restart/opencode-sidebar-sync.user.js",
    label: "Firefox / userscript fallback",
    description: "First release fallback for Firefox. Install with a userscript manager and keep this page open for pairing.",
  },
  {
    href: "/restart/manifest.json",
    label: "Release manifest",
    description: "Machine-readable version, generatedAt, and artifact hashes for verifying downloads.",
  },
]

function isPairingCreatedResponse(value: unknown): value is PairingCreatedResponse {
  if (!value || typeof value !== "object") return false
  return typeof (value as PairingCreatedResponse).code === "string" && typeof (value as PairingCreatedResponse).expiresAt === "string"
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== "object") return false
  const manifest = value as ReleaseManifest
  return (
    typeof manifest.version === "string" &&
    typeof manifest.generatedAt === "string" &&
    Array.isArray(manifest.artifacts) &&
    manifest.artifacts.every((artifact) => typeof artifact.path === "string" && typeof artifact.sha256 === "string")
  )
}

async function createPairing() {
  const response = await fetch("/sidebar-sync/pairing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "restart page" }),
  })
  if (!response.ok) throw new Error("pairing unavailable")
  const json = await response.json()
  if (!isPairingCreatedResponse(json)) throw new Error("pairing response invalid")
  return json
}

async function loadManifest() {
  const response = await fetch("/restart/manifest.json")
  if (!response.ok) throw new Error("manifest unavailable")
  const json = await response.json()
  if (!isReleaseManifest(json)) throw new Error("manifest response invalid")
  return json
}

export default function RestartPage() {
  const [pairing] = createResource(createPairing)
  const [manifest] = createResource(loadManifest)

  return (
    <main class="min-h-screen w-screen overflow-y-auto bg-background-base text-text-strong font-sans">
      <div class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10 md:px-8">
        <section class="rounded-2xl border border-border-weak bg-surface-base/60 p-6 shadow-sm md:p-8">
          <div class="flex flex-col gap-4">
            <div class="text-12-medium uppercase tracking-wide text-text-weak">OpenCode sidebar sync</div>
            <div class="flex flex-col gap-3">
              <h1 class="text-3xl font-semibold tracking-tight md:text-4xl">Restart download and pairing</h1>
              <p class="max-w-3xl text-14-regular leading-6 text-text-weak">
                Install the external sidebar sync helper, then pair this browser with a short-lived code. This page is only
                for the optional sidebar download and pairing flow; it does not patch core OpenCode behavior.
              </p>
            </div>
          </div>
        </section>

        <section class="grid gap-4 md:grid-cols-3">
          <article class="rounded-xl border border-border-weak bg-surface-base p-5">
            <h2 class="text-16-medium">1. Chrome / Edge</h2>
            <p class="mt-2 text-13-regular leading-5 text-text-weak">
              Use the extension zip first on Chrome or Edge. Unzip it and load it as an unpacked extension.
            </p>
          </article>
          <article class="rounded-xl border border-border-weak bg-surface-base p-5">
            <h2 class="text-16-medium">2. Firefox fallback</h2>
            <p class="mt-2 text-13-regular leading-5 text-text-weak">
              Firefox uses the userscript fallback in the first release. Install it with a userscript manager.
            </p>
          </article>
          <article class="rounded-xl border border-border-weak bg-surface-base p-5">
            <h2 class="text-16-medium">3. Mobile</h2>
            <p class="mt-2 text-13-regular leading-5 text-text-weak">
              Mobile browsers are unsupported for syncing. Use this page as read-only installation instructions only.
            </p>
          </article>
        </section>

        <section class="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <article class="rounded-xl border border-border-weak bg-surface-base p-6">
            <h2 class="text-18-medium">Security scope</h2>
            <div class="mt-4 grid gap-4 md:grid-cols-2">
              <div class="rounded-lg border border-border-weak bg-background-base p-4">
                <h3 class="text-14-medium text-text-strong">Synced</h3>
                <p class="mt-2 text-13-regular leading-5 text-text-weak">
                  Only opened sidebar projects are synced: their order, expanded flags, and lastProject per namespace and
                  scope.
                </p>
              </div>
              <div class="rounded-lg border border-border-weak bg-background-base p-4">
                <h3 class="text-14-medium text-text-strong">Not synced</h3>
                <p class="mt-2 text-13-regular leading-5 text-text-weak">
                  server.list, passwords, tokens, credentials, model config, sessions, prompts, provider auth, and the
                  historical /project full list are not synced.
                </p>
              </div>
            </div>
            <p class="mt-4 rounded-lg bg-surface-strong px-4 py-3 text-13-regular text-text-weak">
              No credentials or tokens are requested on this page. Pairing only creates a short-lived code for the helper
              to claim.
            </p>
          </article>

          <article class="rounded-xl border border-border-weak bg-surface-base p-6">
            <h2 class="text-18-medium">Pairing code</h2>
            <Switch>
              <Match when={pairing.loading}>
                <p class="mt-4 text-13-regular text-text-weak">Creating a short-lived pairing code…</p>
              </Match>
              <Match when={pairing.error}>
                <div class="mt-4 rounded-lg border border-border-warning-base bg-background-base p-4">
                  <p class="text-14-medium text-text-strong">Pairing is temporarily unavailable</p>
                  <p class="mt-2 text-13-regular leading-5 text-text-weak">
                    The install links remain available. Refresh this page when the pairing API is reachable again.
                  </p>
                </div>
              </Match>
              <Match when={pairing()}>
                {(value) => (
                  <div class="mt-4 flex flex-col gap-3">
                    <div class="rounded-lg border border-border-weak bg-background-base p-5 text-center">
                      <div class="text-12-medium uppercase tracking-wide text-text-weak">Code</div>
                      <div class="mt-2 font-mono text-3xl font-semibold tracking-widest text-text-strong">
                        {value().code}
                      </div>
                    </div>
                    <p class="text-13-regular text-text-weak">Expires at {value().expiresAt}</p>
                  </div>
                )}
              </Match>
            </Switch>
          </article>
        </section>

        <section class="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <article class="rounded-xl border border-border-weak bg-surface-base p-6">
            <h2 class="text-18-medium">Downloads</h2>
            <div class="mt-4 flex flex-col gap-3">
              <For each={links}>
                {(link) => (
                  <a
                    class="rounded-lg border border-border-weak bg-background-base p-4 transition hover:border-border-strong"
                    href={link.href}
                  >
                    <div class="text-14-medium text-text-interactive-base">{link.label}</div>
                    <p class="mt-1 text-13-regular leading-5 text-text-weak">{link.description}</p>
                    <div class="mt-2 font-mono text-12-regular text-text-weak">{link.href}</div>
                  </a>
                )}
              </For>
            </div>
          </article>

          <article class="rounded-xl border border-border-weak bg-surface-base p-6">
            <h2 class="text-18-medium">Release metadata</h2>
            <Switch>
              <Match when={manifest.loading}>
                <p class="mt-4 text-13-regular text-text-weak">Loading release manifest…</p>
              </Match>
              <Match when={manifest.error}>
                <div class="mt-4 rounded-lg border border-border-warning-base bg-background-base p-4">
                  <p class="text-14-medium text-text-strong">Release manifest is temporarily unavailable</p>
                  <p class="mt-2 text-13-regular leading-5 text-text-weak">
                    Download links are still shown, but version, generatedAt, and artifact hashes cannot be verified from
                    the manifest right now.
                  </p>
                </div>
              </Match>
              <Match when={manifest()}>
                {(value) => (
                  <div class="mt-4 flex flex-col gap-4">
                    <dl class="grid gap-3 rounded-lg border border-border-weak bg-background-base p-4 text-13-regular">
                      <div>
                        <dt class="text-text-weak">Version</dt>
                        <dd class="mt-1 font-mono text-text-strong">{value().version}</dd>
                      </div>
                      <div>
                        <dt class="text-text-weak">generatedAt</dt>
                        <dd class="mt-1 font-mono text-text-strong">{value().generatedAt}</dd>
                      </div>
                    </dl>
                    <div class="flex flex-col gap-2">
                      <For each={value().artifacts}>
                        {(artifact) => (
                          <div class="rounded-lg border border-border-weak bg-background-base p-3">
                            <div class="font-mono text-12-medium text-text-strong">{artifact.path}</div>
                            <div class="mt-1 break-all font-mono text-12-regular text-text-weak">{artifact.sha256}</div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Match>
            </Switch>
          </article>
        </section>
      </div>
    </main>
  )
}

export function restartPageStaticText() {
  return [
    "opened sidebar projects",
    "order",
    "expanded flags",
    "lastProject",
    "server.list",
    "passwords",
    "tokens",
    "credentials",
    "model config",
    "sessions",
    "prompts",
    "historical /project full list",
    "No credentials or tokens are requested on this page",
    ...links.flatMap((link) => [link.href, link.label, link.description]),
  ].join("\n")
}

export { createPairing, loadManifest }
