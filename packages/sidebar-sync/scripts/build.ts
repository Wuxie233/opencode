#!/usr/bin/env bun

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"

const dir = path.resolve(new URL("..", import.meta.url).pathname)
const dist = path.join(dir, "dist")
const extensionDist = path.join(dist, "extension")
const produced: Array<{ path: string; sha256: string }> = []
const warnings: string[] = []

await rm(dist, { recursive: true, force: true })
await mkdir(extensionDist, { recursive: true })

await copyFile(path.join(dir, "public", "manifest.json"), path.join(extensionDist, "manifest.json"))

async function bundle(entrypoint: string, outfile: string) {
  if (!(await Bun.file(entrypoint).exists())) {
    warnings.push(`Skipped missing entrypoint ${path.relative(dir, entrypoint)}`)
    return
  }

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: path.dirname(outfile),
    naming: path.basename(outfile),
    format: "esm",
    minify: true,
    sourcemap: "none",
    target: "browser",
  })

  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n") || `Failed to bundle ${path.relative(dir, entrypoint)}`)
  }
}

function crc32(data: Uint8Array) {
  return data.reduce((crc, byte) => {
    const next = (crc ^ byte) & 0xff
    return (crc >>> 8) ^ Array.from({ length: 8 }).reduce<number>((entry) => (entry & 1 ? 0xedb88320 ^ (entry >>> 1) : entry >>> 1), next)
  }, 0xffffffff) ^ 0xffffffff
}

function blobPart(data: Uint8Array): BlobPart {
  return new Uint8Array(data)
}

function dosTime(date = new Date()) {
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff
}

function dosDate(date = new Date()) {
  return (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(path.join(root, prefix), { withFileTypes: true })).map((entry) =>
        entry.isDirectory() ? listFiles(root, path.join(prefix, entry.name)) : path.join(prefix, entry.name),
      ),
    )
  )
    .flat()
    .sort()
}

async function writeZip(source: string, outfile: string) {
  const encoder = new TextEncoder()
  const now = new Date()
  const entries = await Promise.all(
    (await listFiles(source)).map(async (name) => ({
      name: name.replaceAll(path.sep, "/"),
      data: new Uint8Array(await Bun.file(path.join(source, name)).arrayBuffer()),
    })),
  )
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new ArrayBuffer(30 + name.length)
    const localView = new DataView(local)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(10, dosTime(now), true)
    localView.setUint16(12, dosDate(now), true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, name.length, true)
    new Uint8Array(local, 30).set(name)
    chunks.push(new Uint8Array(local), entry.data)

    const directory = new ArrayBuffer(46 + name.length)
    const directoryView = new DataView(directory)
    directoryView.setUint32(0, 0x02014b50, true)
    directoryView.setUint16(4, 20, true)
    directoryView.setUint16(6, 20, true)
    directoryView.setUint16(12, dosTime(now), true)
    directoryView.setUint16(14, dosDate(now), true)
    directoryView.setUint32(16, crc, true)
    directoryView.setUint32(20, entry.data.length, true)
    directoryView.setUint32(24, entry.data.length, true)
    directoryView.setUint16(28, name.length, true)
    directoryView.setUint32(42, offset, true)
    new Uint8Array(directory, 46).set(name)
    central.push(new Uint8Array(directory))
    offset += local.byteLength + entry.data.length
  }

  const centralSize = central.reduce((total, entry) => total + entry.byteLength, 0)
  const end = new ArrayBuffer(22)
  const endView = new DataView(end)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  await Bun.write(outfile, new Blob([...chunks, ...central, new Uint8Array(end)].map(blobPart)))
}

async function recordArtifact(file: string) {
  produced.push({
    path: path.relative(dist, file).replaceAll(path.sep, "/"),
    sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex"),
  })
}

await bundle(path.join(dir, "src", "extension-content.ts"), path.join(extensionDist, "content.js"))
await bundle(path.join(dir, "src", "userscript.ts"), path.join(dist, "opencode-sidebar-sync.user.js"))
await writeZip(extensionDist, path.join(dist, "opencode-sidebar-sync-extension.zip"))

await Promise.all(
  (
    await listFiles(dist)
  )
    .filter((file) => file !== "manifest.json")
    .map((file) => stat(path.join(dist, file)).then((fileStat) => (fileStat.isFile() ? recordArtifact(path.join(dist, file)) : undefined))),
)

await Bun.file(path.join(dist, "manifest.json")).write(
  JSON.stringify(
    {
      version: pkg.version,
      generatedAt: new Date().toISOString(),
      artifacts: produced.sort((a, b) => a.path.localeCompare(b.path)),
      warnings,
    },
    null,
    2,
  ),
)

warnings.map((warning) => console.warn(warning))
