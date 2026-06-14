import { describe, expect, test } from "bun:test"
import {
  UI_STATE_CONTRACT_VERSION,
  UI_STATE_GROUP_IDS,
  UI_STATE_GROUPS,
  UI_STATE_REQUIRED_METADATA,
  defaultUiStateRecord,
  isUiStateRecord,
  uiStateGroup,
} from "./ui-state-contract"

describe("ui state contract", () => {
  test("contract version is v1", () => {
    expect(UI_STATE_CONTRACT_VERSION).toBe("v1")
  })

  test("group ids include tabs and settings.v3", () => {
    expect(UI_STATE_GROUP_IDS).toContain("tabs")
    expect(UI_STATE_GROUP_IDS).toContain("settings.v3")
  })

  test("group ids are unique", () => {
    expect(new Set(UI_STATE_GROUP_IDS).size).toBe(UI_STATE_GROUP_IDS.length)
    expect(new Set(UI_STATE_GROUPS.map((group) => group.id)).size).toBe(UI_STATE_GROUPS.length)
  })

  test("group ids and group definitions stay in sync", () => {
    expect(UI_STATE_GROUPS.map((group) => group.id).toSorted()).toEqual([...UI_STATE_GROUP_IDS].toSorted())
  })

  test("every group id resolves to a definition with required fields", () => {
    for (const id of UI_STATE_GROUP_IDS) {
      const group = uiStateGroup(id)
      expect(group, id).toBeDefined()
      expect(["global", "workspace", "session"]).toContain(group!.scope)
      expect(typeof group!.key).toBe("string")
      expect(typeof group!.hasMigrate).toBe("boolean")
    }
  })

  test("required metadata is version + updated_at", () => {
    expect([...UI_STATE_REQUIRED_METADATA].toSorted()).toEqual(["updated_at", "version"])
  })

  test("uiStateGroup returns undefined for unknown ids", () => {
    expect(uiStateGroup("does-not-exist")).toBeUndefined()
  })

  test("isUiStateRecord accepts well-formed records", () => {
    expect(isUiStateRecord({ value: { a: 1 }, version: "v1", updated_at: 5 })).toBe(true)
    expect(isUiStateRecord({ value: null, version: "v1", updated_at: 0 })).toBe(true)
    expect(isUiStateRecord(defaultUiStateRecord())).toBe(true)
  })

  test("isUiStateRecord rejects malformed records", () => {
    expect(isUiStateRecord(null)).toBe(false)
    expect(isUiStateRecord([])).toBe(false)
    expect(isUiStateRecord({ version: "v1", updated_at: 5 })).toBe(false)
    expect(isUiStateRecord({ value: 1, version: "v2", updated_at: 5 })).toBe(false)
    expect(isUiStateRecord({ value: 1, version: "v1", updated_at: "bad" })).toBe(false)
    expect(isUiStateRecord({ value: 1, version: "v1", updated_at: Number.NaN })).toBe(false)
    expect(isUiStateRecord({ value: 1, version: "v1", updated_at: -1 })).toBe(false)
  })

  test("defaultUiStateRecord represents an empty remote", () => {
    expect(defaultUiStateRecord()).toEqual({ value: null, version: "v1", updated_at: 0 })
  })
})
