import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"

function node(path: string): FileNode {
  return { path, name: path, absolute: `/${path}`, type: "file", ignored: false }
}

describe("createFileTreeStore", () => {
  test("reset aborts active requests and ignores their late response", async () => {
    const pending = Promise.withResolvers<FileNode[]>()
    let signal: AbortSignal | undefined
    const tree = createFileTreeStore({
      scope: () => "/workspace",
      normalizeDir: (path) => path,
      list: (_path, options) => {
        signal = options.signal
        return pending.promise
      },
      onError: () => {},
    })

    const request = tree.listDir("")
    tree.reset()
    pending.resolve([node("stale.ts")])
    await request

    expect(signal?.aborted).toBeTrue()
    expect(tree.children("")).toEqual([])
    expect(tree.node("stale.ts")).toBeUndefined()
  })

  test("a stale finally cannot remove the replacement request", async () => {
    const first = Promise.withResolvers<FileNode[]>()
    const second = Promise.withResolvers<FileNode[]>()
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/workspace",
      normalizeDir: (path) => path,
      list: () => (++calls === 1 ? first.promise : second.promise),
      onError: () => {},
    })

    const stale = tree.listDir("")
    tree.reset()
    const current = tree.listDir("")
    first.resolve([node("stale.ts")])
    await stale

    expect(tree.listDir("")).toBe(current)

    second.resolve([node("current.ts")])
    await current
    expect(tree.children("").map((item) => item.path)).toEqual(["current.ts"])
  })
})
