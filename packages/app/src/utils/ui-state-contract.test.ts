import { describe, expect, test } from "bun:test"
import {
  UI_STATE_CONTRACT,
  UI_STATE_CONTRACT_VERSION,
  UI_STATE_GROUP_IDS,
  UI_STATE_REQUIRED_METADATA,
  uiStateRecord,
  type UiStateScope,
  type UiStateStorageTarget,
} from "./ui-state-contract"

describe("UI_STATE_CONTRACT", () => {
  test("declares the v1 version", () => {
    expect(UI_STATE_CONTRACT.version).toBe("v1")
    expect(UI_STATE_CONTRACT_VERSION).toBe("v1")
  })

  test("has no duplicate group ids", () => {
    const ids = UI_STATE_CONTRACT.records.map((record) => record.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("covers exactly the selected v1 keys", () => {
    const ids = new Set(UI_STATE_CONTRACT.records.map((record) => record.id))
    const expected = new Set<string>(UI_STATE_GROUP_IDS)
    expect(ids).toEqual(expected)
  })

  test("requires version and updated_at metadata", () => {
    expect(UI_STATE_CONTRACT.metadata.version.field).toBe("version")
    expect(UI_STATE_CONTRACT.metadata.version.required).toBe(true)
    expect(UI_STATE_CONTRACT.metadata.updatedAt.field).toBe("updated_at")
    expect(UI_STATE_CONTRACT.metadata.updatedAt.required).toBe(true)
    expect(UI_STATE_CONTRACT.metadata.updatedAt.type).toBe("number")
    expect([...UI_STATE_REQUIRED_METADATA]).toEqual(["version", "updated_at"])
  })

  test("metadata version is a string contract version, not a numeric revision", () => {
    expect(UI_STATE_CONTRACT.metadata.version.type).toBe("string")
    expect(UI_STATE_CONTRACT.metadata.version.value).toBe("v1")
    expect(UI_STATE_CONTRACT.metadata.version.value).toBe(UI_STATE_CONTRACT.version)
    expect(typeof UI_STATE_CONTRACT.metadata.version.value).toBe("string")
  })

  test("every record carries the required fields and metadata", () => {
    const scopes: UiStateScope[] = ["global", "workspace"]
    const targets: UiStateStorageTarget[] = ["global-dat", "workspace-dat", "direct-local"]

    for (const record of UI_STATE_CONTRACT.records) {
      expect(record.id.length).toBeGreaterThan(0)
      expect(record.record.length).toBeGreaterThan(0)
      expect(record.key.length).toBeGreaterThan(0)
      expect(record.notes.length).toBeGreaterThan(0)
      expect(scopes).toContain(record.scope)
      expect(targets).toContain(record.storageTarget)
      expect(Array.isArray(record.legacyKeys)).toBe(true)
      expect(typeof record.hasMigrate).toBe("boolean")
      expect([...record.requiresMetadata]).toEqual(["version", "updated_at"])
    }
  })

  test("scope and storage target stay consistent", () => {
    for (const record of UI_STATE_CONTRACT.records) {
      if (record.storageTarget === "workspace-dat") {
        expect(record.scope).toBe("workspace")
        expect(record.key.startsWith("workspace:")).toBe(true)
      }
      if (record.scope === "workspace") {
        expect(record.storageTarget).toBe("workspace-dat")
      }
    }
  })

  test("uiStateRecord looks up by id and matches keys", () => {
    expect(uiStateRecord("server")?.key).toBe("server")
    expect(uiStateRecord("settings.v3")?.storageTarget).toBe("direct-local")
    expect(uiStateRecord("workspace:model-selection")?.scope).toBe("workspace")
    expect(uiStateRecord("command.catalog.v1")?.legacyKeys.length).toBe(0)
    expect(uiStateRecord("missing")).toBeUndefined()
  })
})
