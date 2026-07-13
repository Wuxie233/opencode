export const normalizeModelSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)
  if (!search) return true

  const compactSearch = compactModelSearch(query)
  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}

export function sortModels<T>(models: readonly T[], name: (model: T) => string) {
  return [...models].sort((a, b) => name(a).localeCompare(name(b)))
}

export function filterModels<T>(models: readonly T[], query: string, fields: (model: T) => string[]) {
  const search = query.trim()
  if (!search) return models
  return models.filter((model) => matchesModelSearch(search, fields(model)))
}

export function groupModels<T>(models: readonly T[], category: (model: T) => string) {
  const grouped = new Map<string, T[]>()
  for (const model of models) {
    const key = category(model)
    const items = grouped.get(key)
    if (items) {
      items.push(model)
      continue
    }
    grouped.set(key, [model])
  }
  return Array.from(grouped, ([category, items]) => ({ category, items }))
}
