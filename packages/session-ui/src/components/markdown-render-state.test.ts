import { expect, test } from "bun:test"
import { pendingMarkdownResult, settleMarkdownRender } from "./markdown-render-state"
import { MarkdownWorkerDisposedError, MarkdownWorkerSupersededError } from "./markdown-worker-protocol"

test("does not settle a successful render after supersession", async () => {
  let active = true
  let resolve = (_value: string) => {}
  const pending = new Promise<string>((done) => {
    resolve = done
  })

  const result = settleMarkdownRender({ render: () => pending, active: () => active, fallback: () => "fallback" })
  active = false
  resolve("stale")

  expect(await result).toBeUndefined()
})

test("does not publish fallback after an inactive render rejects", async () => {
  let active = true
  let reject = (_error: Error) => {}
  let fallback = false
  const pending = new Promise<string>((_resolve, fail) => {
    reject = fail
  })

  const result = settleMarkdownRender({
    render: () => pending,
    active: () => active,
    fallback: () => {
      fallback = true
      return "fallback"
    },
  })
  active = false
  reject(new Error("late failure"))

  expect(await result).toBeUndefined()
  expect(fallback).toBe(false)
})

for (const error of [new MarkdownWorkerDisposedError(), new MarkdownWorkerSupersededError()]) {
  test(`does not convert ${error.constructor.name} into fallback content`, async () => {
    let fallback = false

    const result = await settleMarkdownRender({
      render: () => Promise.reject(error),
      active: () => true,
      fallback: () => {
        fallback = true
        return "fallback"
      },
    })

    expect(result).toBeUndefined()
    expect(fallback).toBe(false)
  })
}

test("uses fallback for an active unexpected failure", async () => {
  const result = await settleMarkdownRender({
    render: () => Promise.reject(new Error("parse failed")),
    active: () => true,
    fallback: () => "fallback",
  })

  expect(result).toBe("fallback")
})

test("keeps pending async projection empty instead of exposing raw fallback content", () => {
  expect(pendingMarkdownResult("<script>secret</script>", 0)).toEqual({
    text: "<script>secret</script>",
    blocks: [],
  })
  expect(pendingMarkdownResult("ready", 1)).toBeUndefined()
})
