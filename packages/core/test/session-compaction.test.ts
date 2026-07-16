import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## User Requests")
  expect(prompt).toContain("## Goal")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Pending Tasks")
  expect(prompt).toContain("## Key Files")
  expect(prompt).toContain("## Important Decisions")
  expect(prompt).toContain("## Explicit Constraints")
  expect(prompt).toContain("## Continuation Context")
  expect(prompt).toContain("Do not claim tests or builds passed unless the history shows that they did.")
})

test("compaction prompt preserves previous summary update flow", () => {
  const prompt = SessionCompaction.buildPrompt({
    previousSummary: "## Goal\n- Preserve existing context",
    context: ["new conversation history"],
  })

  expect(prompt).toContain("Update the anchored summary below")
  expect(prompt).toContain("<previous-summary>\n## Goal\n- Preserve existing context\n</previous-summary>")
  expect(prompt).toContain("## User Requests")
  expect(prompt).toContain("new conversation history")
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
