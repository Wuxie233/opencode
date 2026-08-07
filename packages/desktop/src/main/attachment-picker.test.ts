import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertAttachmentBudget,
  createPickedFileAuthorizations,
  MAX_ATTACHMENT_CHUNK_BYTES,
  readAttachment,
} from "./attachment-picker"

describe("assertAttachmentBudget", () => {
  test("accepts selections without an application size cap", () => {
    expect(() => assertAttachmentBudget([{ size: 5 * 1024 * 1024 * 1024 }, { size: 1 }])).not.toThrow()
  })

  test("accepts large selections when storage can represent their sizes", () => {
    expect(() => assertAttachmentBudget([{ size: 5 * 1024 * 1024 * 1024 }, { size: 1 }])).not.toThrow()
  })

  test("reads an approved file by offset and length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-attachment-"))
    const file = join(directory, "example.txt")
    try {
      await writeFile(file, "lorem ipsum")
      expect(new TextDecoder().decode(await readAttachment(file, 6, 5))).toBe("ipsum")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("picked file authorizations", () => {
  const read = async (path: string, offset: number, length: number) =>
    new TextEncoder().encode(path).slice(offset, offset + length).buffer

  test("keeps concurrent picker selections isolated", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, [
      { path: "a.txt", size: 5 },
      { path: "b.txt", size: 5 },
    ])
    const second = authorizations.add(1, [{ path: "c.txt", size: 5 }])

    expect(new TextDecoder().decode(await authorizations.read(1, first, "a.txt", 0, 5))).toBe("a.txt")
    expect(new TextDecoder().decode(await authorizations.read(1, second, "c.txt", 0, 5))).toBe("c.txt")
    expect(new TextDecoder().decode(await authorizations.read(1, first, "b.txt", 0, 5))).toBe("b.txt")
  })

  test("releases unread files for one picker without affecting another", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, [{ path: "a.txt", size: 5 }])
    const second = authorizations.add(1, [{ path: "b.txt", size: 5 }])
    authorizations.release(1, first)

    await expect(authorizations.read(1, first, "a.txt", 0, 5)).rejects.toThrow("not selected")
    expect(new TextDecoder().decode(await authorizations.read(1, second, "b.txt", 0, 5))).toBe("b.txt")
  })

  test("keeps picker tokens scoped to their renderer", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, [{ path: "a.txt", size: 5 }])

    await expect(authorizations.read(2, token, "a.txt", 0, 5)).rejects.toThrow("not selected")
  })

  test("releases one file without affecting another file in the selection", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, [
      { path: "a.txt", size: 5 },
      { path: "b.txt", size: 5 },
    ])
    authorizations.release(1, token, "a.txt")

    await expect(authorizations.read(1, token, "a.txt", 0, 5)).rejects.toThrow("not selected")
    expect(new TextDecoder().decode(await authorizations.read(1, token, "b.txt", 0, 5))).toBe("b.txt")
  })

  test("releases every selection owned by a destroyed renderer", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, [{ path: "a.txt", size: 5 }])
    const second = authorizations.add(1, [{ path: "b.txt", size: 5 }])
    const other = authorizations.add(2, [{ path: "c.txt", size: 5 }])
    authorizations.releaseSender(1)

    await expect(authorizations.read(1, first, "a.txt", 0, 5)).rejects.toThrow("not selected")
    await expect(authorizations.read(1, second, "b.txt", 0, 5)).rejects.toThrow("not selected")
    expect(new TextDecoder().decode(await authorizations.read(2, other, "c.txt", 0, 5))).toBe("c.txt")
  })

  test("rejects renderer requests larger than one chunk", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, [{ path: "a.txt", size: MAX_ATTACHMENT_CHUNK_BYTES + 1 }])

    await expect(authorizations.read(1, token, "a.txt", 0, MAX_ATTACHMENT_CHUNK_BYTES + 1)).rejects.toThrow("limit")
  })
})
