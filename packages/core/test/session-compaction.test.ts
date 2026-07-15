import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction prompt keeps prior state and newer history in separate inputs", () => {
  const prompt = SessionCompaction.buildPrompt({
    previousSummary: "prior-state-sentinel",
    context: ["new-history-sentinel"],
  })

  expect(prompt).toContain("<previous-summary>\nprior-state-sentinel\n</previous-summary>")
  expect(prompt).toContain("new-history-sentinel")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})
