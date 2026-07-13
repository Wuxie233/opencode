import { describe, expect, test } from "bun:test"
import { preloadLayoutSessions } from "./layout-session-preload"

describe("preloadLayoutSessions", () => {
  test("deduplicates directories and limits background requests", async () => {
    const directories = ["C:/repo", "C:\\repo\\", ...Array.from({ length: 8 }, (_, index) => `C:/project-${index}`)]
    const loaded: string[] = []
    let active = 0
    let peak = 0

    await preloadLayoutSessions(directories, async (directory) => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(1)
      loaded.push(directory)
      active--
    })

    expect(peak).toBe(4)
    expect(loaded).toHaveLength(9)
    expect(loaded.filter((directory) => directory.toLowerCase() === "c:/repo")).toEqual(["C:/repo"])
  })
})
