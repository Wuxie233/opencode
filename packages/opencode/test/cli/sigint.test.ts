import { expect, test } from "bun:test"
import { Sigint } from "../../src/cli/sigint"

test("dispatches to the active command owner", () => {
  let handled = 0
  const unregister = Sigint.register(() => {
    handled++
    return true
  })

  expect(Sigint.dispatch()).toBe(true)
  expect(handled).toBe(1)
  unregister()
  expect(Sigint.dispatch()).toBe(false)
})

test("the active command can delegate a repeated signal", () => {
  let first = true
  const unregister = Sigint.register(() => {
    if (!first) return false
    first = false
    return true
  })

  expect(Sigint.dispatch()).toBe(true)
  expect(Sigint.dispatch()).toBe(false)
  unregister()
})
