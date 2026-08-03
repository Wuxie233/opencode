import { describe, expect, test } from "bun:test"
import { resolvePersonalUI } from "./flag"

describe("resolvePersonalUI", () => {
  test("defaults to the upstream layout during rollout", () => {
    expect(resolvePersonalUI({ search: "" })).toEqual({ enabled: false })
  })

  test("uses the persisted browser preference", () => {
    expect(resolvePersonalUI({ search: "", stored: "1" })).toEqual({ enabled: true })
    expect(resolvePersonalUI({ search: "", stored: "0" })).toEqual({ enabled: false })
  })

  test("query overrides and persists the preference", () => {
    expect(resolvePersonalUI({ search: "?personal-ui=1", stored: "0" })).toEqual({ enabled: true, persist: "1" })
    expect(resolvePersonalUI({ search: "?personal-ui=0", stored: "1" })).toEqual({ enabled: false, persist: "0" })
  })

  test("ignores unsupported query values", () => {
    expect(resolvePersonalUI({ search: "?personal-ui=yes", stored: "1" })).toEqual({ enabled: true })
  })
})
