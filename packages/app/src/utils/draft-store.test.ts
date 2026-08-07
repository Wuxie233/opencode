import { afterEach, describe, expect, test } from "bun:test"
import { blobDataUrl } from "./draft-store"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("blobDataUrl", () => {
  test("reads the persisted Blob before fetching its preview URL", async () => {
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("failed to fetch preview")
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await blobDataUrl({ id: "blob_1", url: "blob:expired" }, "image/png", async (id) =>
      id === "blob_1" ? new Blob([Uint8Array.of(1, 2)]) : null,
    )

    expect(result).toBe("data:image/png;base64,AQI=")
  })
})
