import { expect, test } from "bun:test"
import { renderProgressively } from "./markdown-progressive"

test("publishes bounded progressive batches", async () => {
  const published: number[] = []
  const items = Array.from({ length: 200 }, (_, index) => ({ raw: "x", index }))

  const result = await renderProgressively({
    items,
    active: () => true,
    render: async (item) => item.index,
    publish: (values) => published.push(values.length),
  })

  expect(published).toEqual([128, 200])
  expect(result).toHaveLength(200)
})

test("stops publishing when a render is superseded", async () => {
  const published: number[] = []
  let active = true
  const items = Array.from({ length: 3 }, (_, index) => ({ raw: "x".repeat(20 * 1024), index }))

  const result = await renderProgressively({
    items,
    active: () => active,
    render: async (item) => item.index,
    publish: (values) => {
      published.push(values.length)
      active = false
    },
  })

  expect(published).toEqual([1])
  expect(result).toEqual([0])
})
