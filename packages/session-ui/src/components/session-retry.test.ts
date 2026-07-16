import { describe, expect, test } from "bun:test"
import { ScriptKind, ScriptTarget, createSourceFile, forEachChild, isJsxAttribute, isJsxElement } from "typescript"
import type { Node } from "typescript"

const source = createSourceFile(
  "session-retry.tsx",
  await Bun.file(new URL("./session-retry.tsx", import.meta.url)).text(),
  ScriptTarget.Latest,
  true,
  ScriptKind.TSX,
)

function retryActionClasses() {
  let value = ""
  const visit = (node: Node) => {
    if (isJsxElement(node) && node.openingElement.tagName.getText(source) === "Button") {
      const attribute = node.openingElement.attributes.properties
        .filter(isJsxAttribute)
        .find((item) => item.name.getText(source) === "class")
      if (attribute?.initializer && "text" in attribute.initializer) value = attribute.initializer.text
    }
    forEachChild(node, visit)
  }
  visit(source)
  return new Set(value.split(" "))
}

describe("SessionRetry", () => {
  test("keeps a 44px mobile action target and compact desktop height", () => {
    const classes = retryActionClasses()

    expect(classes.has("min-h-11")).toBe(true)
    expect(classes.has("md:min-h-6")).toBe(true)
  })
})
