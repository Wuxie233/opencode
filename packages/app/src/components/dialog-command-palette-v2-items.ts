import type { CommandPaletteEntry } from "./command-palette"

export type RemoteCommandPaletteEntries = {
  query: string
  entries: CommandPaletteEntry[]
}

export function groupCommandPaletteEntries(entries: CommandPaletteEntry[]) {
  const grouped = new Map<string, CommandPaletteEntry[]>()
  for (const entry of entries) {
    const items = grouped.get(entry.category)
    if (items) {
      items.push(entry)
      continue
    }
    grouped.set(entry.category, [entry])
  }
  return Array.from(grouped, ([category, entries]) => ({ category, entries }))
}

export function matchesCommandPaletteEntry(entry: CommandPaletteEntry, query: string) {
  const value = query.toLowerCase()
  return [entry.title, entry.description, entry.category].some((text) => text?.toLowerCase().includes(value))
}

export function commandPaletteVisibleEntries(
  local: CommandPaletteEntry[],
  remote: RemoteCommandPaletteEntries | undefined,
  query: string,
) {
  const entries = remote?.query === query.trim() ? [...local, ...remote.entries] : local
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
}
