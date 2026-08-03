import { describe, expect, test } from "bun:test"
import { personalMessages, personalMessagesZh, personalMessagesZht } from "./i18n"

describe("Personal UI translations", () => {
  test("keeps simplified and traditional Chinese keys and placeholders aligned", () => {
    const keys = Object.keys(personalMessages)
    expect(Object.keys(personalMessagesZh)).toEqual(keys)
    expect(Object.keys(personalMessagesZht)).toEqual(keys)

    for (const key of keys) {
      const source = personalMessages[key as keyof typeof personalMessages]
      const simplified = personalMessagesZh[key as keyof typeof personalMessagesZh]
      const traditional = personalMessagesZht[key as keyof typeof personalMessagesZht]
      expect(placeholders(simplified)).toEqual(placeholders(source))
      expect(placeholders(traditional)).toEqual(placeholders(source))
    }
  })
})

function placeholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]).sort()
}
