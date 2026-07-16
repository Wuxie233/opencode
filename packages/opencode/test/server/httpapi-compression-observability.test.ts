import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { compressBody } from "../../src/server/routes/instance/httpapi/middleware/compression"
import { it } from "../lib/effect"

it.live("moves buffered compression off the current JavaScript turn", () =>
  Effect.gen(function* () {
    const input = new TextEncoder().encode("compression-work-".repeat(65_536))

    for (const encoding of ["gzip", "deflate"] as const) {
      const fiber = Effect.runFork(compressBody(input, encoding))
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect((yield* Fiber.join(fiber)).byteLength).toBeGreaterThan(0)
    }
  }),
)
