import { sentryVitePlugin } from "@sentry/vite-plugin"
import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const sidebarSyncDist = path.resolve(import.meta.dirname, "../sidebar-sync/dist")
const restartDist = path.resolve(import.meta.dirname, "dist", "restart")
const exec = promisify(execFile)

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

function restartArtifactsPlugin() {
  return {
    name: "opencode-restart-artifacts",
    apply: "build" as const,
    closeBundle: async () => {
      if (!(await exists(sidebarSyncDist))) {
        console.warn("sidebar-sync dist not found; skipping restart artifacts")
        return
      }

      await rm(restartDist, { recursive: true, force: true })
      await mkdir(restartDist, { recursive: true })
      await copyFile(path.join(sidebarSyncDist, "manifest.json"), path.join(restartDist, "manifest.json"))
      if (await exists(path.join(sidebarSyncDist, "opencode-sidebar-sync.user.js"))) {
        await copyFile(path.join(sidebarSyncDist, "opencode-sidebar-sync.user.js"), path.join(restartDist, "opencode-sidebar-sync.user.js"))
      } else {
        console.warn("sidebar-sync userscript artifact not found; bundling restart userscript fallback")
        await exec("bun", [
          "build",
          path.join(import.meta.dirname, "../sidebar-sync/src/userscript.ts"),
          "--outfile",
          path.join(restartDist, "opencode-sidebar-sync.user.js"),
          "--format=esm",
          "--minify",
          "--target=browser",
        ])
      }

      const extensionZip = path.join(sidebarSyncDist, "opencode-sidebar-sync-extension.zip")
      if (await exists(extensionZip)) {
        await copyFile(extensionZip, path.join(restartDist, "opencode-sidebar-sync-extension.zip"))
        return
      }

      console.warn("sidebar-sync extension zip not found; copying extension directory fallback")
      await cp(path.join(sidebarSyncDist, "extension"), path.join(restartDist, "opencode-sidebar-sync-extension"), {
        recursive: true,
      })
    },
  }
}

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, sentry, restartArtifactsPlugin()] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
