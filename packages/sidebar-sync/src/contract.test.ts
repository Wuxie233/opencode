import { describe, expect, test } from "bun:test"
import type {
  ClaimPairingRequest,
  ClaimPairingResponse,
  CreatePairingRequest,
  CreatePairingResponse,
  GetSidebarStateResponse,
  PutSidebarStateRequest,
  PutSidebarStateResponse,
  SidebarConflictResponse,
} from "./contract"
import {
  containsForbiddenKey,
  CURRENT_SERVER_STORAGE_KEY,
  LEGACY_SERVER_STORAGE_KEY,
  SIDEBAR_SCHEMA_VERSION,
  validateSidebarStatePayload,
} from "./contract"

describe("sidebar sync contract", () => {
  test("exports storage keys and schema version", () => {
    expect(SIDEBAR_SCHEMA_VERSION).toBe(1)
    expect(CURRENT_SERVER_STORAGE_KEY).toBe("opencode.global.dat:server")
    expect(LEGACY_SERVER_STORAGE_KEY).toBe("server.v3")
  })

  test("accepts only sidebar project state with schemaVersion, projects, and lastProject", () => {
    const result = validateSidebarStatePayload({
      schemaVersion: 1,
      projects: [
        { worktree: "/repo/a", expanded: true },
        { worktree: "/repo/b", expanded: false },
      ],
      lastProject: "/repo/a",
    })

    expect(result.ok).toBeTrue()
    if (result.ok) {
      expect(result.value).toEqual({
        schemaVersion: 1,
        projects: [
          { worktree: "/repo/a", expanded: true },
          { worktree: "/repo/b", expanded: false },
        ],
        lastProject: "/repo/a",
      })
    }
  })

  test("accepts payload without lastProject", () => {
    expect(validateSidebarStatePayload({ schemaVersion: 1, projects: [] })).toEqual({
      ok: true,
      value: { schemaVersion: 1, projects: [] },
    })
  })

  test("rejects credential and unrelated server fields", () => {
    expect(
      validateSidebarStatePayload({
        schemaVersion: 1,
        projects: [{ worktree: "/repo", expanded: true }],
        server: { list: ["http://localhost:4096"] },
      }),
    ).toEqual({ ok: false, error: "Forbidden key: server.list" })

    expect(
      validateSidebarStatePayload({
        schemaVersion: 1,
        projects: [],
        server: { current: "local" },
      }),
    ).toEqual({ ok: false, error: "Unexpected key: server" })

    expect(
      validateSidebarStatePayload({
        schemaVersion: 1,
        projects: [],
        credential: "secret",
      }),
    ).toEqual({ ok: false, error: "Forbidden key: credential" })
  })

  test("rejects token inside project entry", () => {
    expect(
      validateSidebarStatePayload({
        schemaVersion: 1,
        projects: [{ worktree: "/repo", expanded: true, token: "secret" }],
      }),
    ).toEqual({ ok: false, error: "Forbidden key: projects.0.token" })
  })

  test("detects forbidden keys at any depth", () => {
    expect(containsForbiddenKey({ nested: { provider_auth: "secret" } })).toBeTrue()
    expect(containsForbiddenKey({ nested: [{ authorization: "Bearer secret" }] })).toBeTrue()
    expect(containsForbiddenKey({ schemaVersion: 1, projects: [{ worktree: "/repo", expanded: true }] })).toBeFalse()
  })

  test("exports endpoint request and response schema types", () => {
    const createPairingRequest: CreatePairingRequest = { label: "browser" }
    const createPairingResponse: CreatePairingResponse = { code: "123456", expiresAt: "2026-05-16T00:00:00.000Z" }
    const claimPairingRequest: ClaimPairingRequest = { deviceName: "laptop" }
    const claimPairingResponse: ClaimPairingResponse = { deviceId: "device-1", token: "token-1" }
    const getSidebarStateResponse: GetSidebarStateResponse = {
      namespace: "personal",
      scope: "local",
      version: 1,
      updatedAt: "2026-05-16T00:00:00.000Z",
      updatedByDeviceId: "device-1",
      payload: { schemaVersion: 1, projects: [] },
    }
    const putSidebarStateRequest: PutSidebarStateRequest = {
      baseVersion: 1,
      payload: { schemaVersion: 1, projects: [{ worktree: "/repo", expanded: true }] },
    }
    const putSidebarStateResponse: PutSidebarStateResponse = getSidebarStateResponse
    const conflictResponse: SidebarConflictResponse = {
      error: "VersionConflict",
      current: getSidebarStateResponse,
    }

    expect(createPairingRequest).toEqual({ label: "browser" })
    expect(createPairingResponse.code).toBe("123456")
    expect(claimPairingRequest).toEqual({ deviceName: "laptop" })
    expect(claimPairingResponse.deviceId).toBe("device-1")
    expect(getSidebarStateResponse.payload.projects).toEqual([])
    expect(putSidebarStateRequest.payload.projects).toEqual([{ worktree: "/repo", expanded: true }])
    expect(putSidebarStateResponse).toBe(getSidebarStateResponse)
    expect(conflictResponse.error).toBe("VersionConflict")
  })
})
