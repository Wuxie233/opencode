import "../../../app/happydom"
import { describe, expect, test } from "bun:test"
import { marked, type Tokens } from "marked"
import { sanitizeMarkdown } from "./markdown-cache"
import { projectCompleted } from "./markdown-stream"

const large = "a".repeat(65 * 1024)

marked.use({
  extensions: [
    {
      name: "wave10BlockMath",
      level: "block",
      tokenizer(source) {
        const match = source.match(/^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/)
        if (!match) return
        return { type: "wave10BlockMath", raw: match[0], text: match[1] }
      },
      renderer(token: Tokens.Generic) {
        return `<div data-math>${token.text}</div>`
      },
    },
  ],
})

async function sanitized(markdown: string) {
  const root = document.createElement("div")
  root.innerHTML = sanitizeMarkdown(await marked.parse(markdown))
  return Array.from(root.children).map((element) => element.outerHTML)
}

async function projected(markdown: string) {
  const projection = await projectCompleted(markdown, () => true)
  const blocks = projection?.blocks ?? []
  const html = (
    await Promise.all(blocks.map((block) => sanitized(block.mode === "code" ? block.raw : block.src)))
  ).flat()
  return { blocks, html }
}

describe("completed markdown semantic projection", () => {
  test("does not expose content from an oversized type-1 HTML block", async () => {
    const markdown = `<script>\n${"x".repeat(70 * 1024)}\n\nVISIBLE_INSIDE_SCRIPT\n</script>\n\nAfter`

    const whole = await sanitized(markdown)
    const result = await projected(markdown)

    expect(result.html).toEqual(whole)
    expect(result.html).toEqual(["<p>After</p>"])
  })

  test("does not expose content from an oversized style block", async () => {
    const markdown = `<style>\n${"x".repeat(70 * 1024)}\n\nVISIBLE_INSIDE_STYLE\n</style>\n\nAfter`

    const whole = await sanitized(markdown)
    const result = await projected(markdown)

    expect(result.html).toEqual(whole)
    expect(result.html).toEqual(["<p>After</p>"])
  })

  const fixtures = {
    "multiline code spans": `${large}\n\n\`\`one\ntwo\`\`\n\nAfter`,
    "setext headings": `${large}\n\nHeading\n===\n\nAfter`,
    blockquotes: `${large}\n\n> quote\n>\n> continuation\n\nAfter`,
    "nested loose lists": `${large}\n\n- item\n\n  continuation\n  - nested\n\nAfter`,
    tables: `${large}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter`,
    "block math": `${large}\n\n$$\nx + y\n$$\n\nAfter`,
    "long backtick fences": `${large}\n\n\`\`\`\`typescript meta\nconst x = 1\n\`\`\`\`\n\nAfter`,
    "long tilde fences": `${large}\n\n~~~~typescript meta\nconst x = 1\n~~~~\n\nAfter`,
    CRLF: `${large}\r\n\r\nHeading\r\n---\r\n\r\nAfter`,
  }

  for (const [name, markdown] of Object.entries(fixtures)) {
    test(`preserves sanitized DOM across ${name}`, async () => {
      const whole = await sanitized(markdown)
      const result = await projected(markdown)

      expect(result.html).toEqual(whole)
      expect(result.blocks.map((block) => block.raw).join("")).toBe(markdown)
    })
  }

  test("preserves reference resolution without keeping the whole document in one block", async () => {
    const markdown = `[docs][id]\n\n${large}\n\n[id]: https://example.com\n\nAfter`

    const whole = await sanitized(markdown)
    const result = await projected(markdown)

    expect(result.html).toEqual(whole)
    expect(result.blocks.length).toBeGreaterThan(1)
    expect(result.blocks.map((block) => block.raw).join("")).toBe(markdown)
  })

  test("stops completed projection after an early snapshot is superseded", async () => {
    const markdown = `Paragraph\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n\n`.repeat(4000)
    let active = true
    let published = 0

    const result = await projectCompleted(
      markdown,
      () => active,
      () => {
        published++
        active = false
      },
    )

    expect(result).toBeUndefined()
    expect(published).toBe(1)
  })
})
