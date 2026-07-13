import { describe, expect, test } from "bun:test"
import type { CommandPaletteEntry } from "./command-palette"
import {
  commandPaletteVisibleEntries,
  groupCommandPaletteEntries,
  matchesCommandPaletteEntry,
} from "./dialog-command-palette-v2-items"

function entry(id: string, type: CommandPaletteEntry["type"], category: string): CommandPaletteEntry {
  return { id, type, category, title: id }
}

describe("command palette v2 items", () => {
  test("shows local entries before the current remote search finishes", () => {
    const local = [entry("command:open", "command", "Commands")]
    const stale = { query: "old", entries: [entry("file:old", "file", "Files")] }

    expect(commandPaletteVisibleEntries(local, stale, "new")).toEqual(local)
  })

  test("appends current remote entries in order and removes duplicates", () => {
    const command = entry("command:open", "command", "Commands")
    const session = entry("session:one", "session", "Sessions")
    const file = entry("file:one", "file", "Files")

    expect(
      commandPaletteVisibleEntries([command], { query: "open", entries: [command, session, file] }, " open ").map(
        (item) => item.id,
      ),
    ).toEqual(["command:open", "session:one", "file:one"])
  })

  test("groups entries without changing category or item order", () => {
    const entries = [
      entry("command:one", "command", "Commands"),
      entry("command:two", "command", "Commands"),
      entry("file:one", "file", "Files"),
    ]
    const grouped = groupCommandPaletteEntries(entries)

    expect(grouped.map((group) => group.category)).toEqual(["Commands", "Files"])
    expect(grouped[0]?.entries.map((item) => item.id)).toEqual(["command:one", "command:two"])
  })

  test("matches the same searchable fields case-insensitively", () => {
    const item = { ...entry("command:open", "command", "Commands"), title: "Open File", description: "Pick a path" }

    expect(matchesCommandPaletteEntry(item, "open")).toBeTrue()
    expect(matchesCommandPaletteEntry(item, "PATH")).toBeTrue()
    expect(matchesCommandPaletteEntry(item, "commands")).toBeTrue()
    expect(matchesCommandPaletteEntry(item, "session")).toBeFalse()
  })
})
