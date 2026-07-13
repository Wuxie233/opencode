import { describe, expect, test } from "bun:test"
import { filterModels, groupModels, matchesModelSearch, sortModels } from "./dialog-select-model-search"

describe("matchesModelSearch", () => {
  test("matches model names across separators", () => {
    expect(matchesModelSearch("gpt 5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt-5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt5", ["GPT-5.5"])).toBe(true)
  })

  test("matches any searchable model field", () => {
    expect(matchesModelSearch("open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
    expect(matchesModelSearch("gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
  })

  test("does not match unrelated searches", () => {
    expect(matchesModelSearch("claude", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(false)
  })
})

describe("model search collections", () => {
  const models = [
    { id: "z", name: "Zulu", provider: "two" },
    { id: "a", name: "Alpha", provider: "one" },
    { id: "b", name: "Beta", provider: "one" },
  ]

  test("sorts once while preserving search behavior", () => {
    const fields = (model: (typeof models)[number]) => [model.name, model.id, model.provider]
    const name = (model: (typeof models)[number]) => model.name
    const sorted = sortModels(models, name)

    expect(filterModels(sorted, "", fields).map((model) => model.id)).toEqual(["a", "b", "z"])
    expect(filterModels(sorted, "one", fields).map((model) => model.id)).toEqual(["a", "b"])
    expect(filterModels(sorted, "bet", fields).map((model) => model.id)).toEqual(["b"])
  })

  test("groups models without changing their sorted order", () => {
    const sorted = sortModels(models, (model) => model.name)
    const grouped = groupModels(sorted, (model) => model.provider)

    expect(grouped.map((group) => group.category)).toEqual(["one", "two"])
    expect(grouped[0]?.items.map((model) => model.id)).toEqual(["a", "b"])
  })
})
