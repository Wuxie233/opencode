import { marked, type Tokens } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

const completeBlockSize = 64 * 1024
const lexerWindowSize = 1024

export function requiresCompletedProjection(text: string) {
  return text.length > completeBlockSize
}

function refs(text: string) {
  if (!text.includes("]:")) return false
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")
  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]
  if (!mark) return suffix.includes("```") || suffix.includes("~~~")
  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

type CompleteToken = {
  token: Tokens.Generic
  raw: string
}

function originalEnd(text: string, start: number, length: number) {
  let cursor = start
  let consumed = 0
  while (cursor < text.length && consumed < length) {
    if (text[cursor] === "\r" && text[cursor + 1] === "\n") cursor++
    cursor++
    consumed++
  }
  return cursor
}

function* completeTokens(text: string) {
  let cursor = 0
  while (cursor < text.length) {
    let size = lexerWindowSize
    let end = Math.min(text.length, cursor + size)
    let tokens = marked.lexer(text.slice(cursor, end))
    let count = end === text.length ? tokens.length : tokens.findLastIndex((token) => token.type !== "space")
    while (count <= 0 && end < text.length) {
      size *= 2
      end = Math.min(text.length, cursor + size)
      tokens = marked.lexer(text.slice(cursor, end))
      count = end === text.length ? tokens.length : tokens.findLastIndex((token) => token.type !== "space")
    }

    for (const token of tokens.slice(0, count)) {
      const next = originalEnd(text, cursor, token.raw.length)
      yield { token, raw: text.slice(cursor, next) } satisfies CompleteToken
      cursor = next
    }
  }
}

type CompleteBlockState = {
  blocks: Block[]
  prefix: string
  prose: string
}

function pushProse(state: CompleteBlockState) {
  if (!state.prose) return
  state.blocks.push({ raw: state.prose, src: state.prefix + state.prose, mode: "full" })
  state.prose = ""
}

function appendCompleteToken(state: CompleteBlockState, item: CompleteToken) {
  if (item.token.type === "code") {
    pushProse(state)
    const code = item.token as Tokens.Code
    state.blocks.push({ raw: item.raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
    return
  }
  if (state.prose && state.prose.length + item.raw.length > completeBlockSize) pushProse(state)
  state.prose += item.raw
}

function completeBlocks(tokens: CompleteToken[]): Block[] {
  const definitions = tokens
    .filter((item) => item.token.type === "def")
    .map((item) => item.raw)
    .join("")
  const state = { blocks: [], prefix: definitions ? `${definitions}\n\n` : "", prose: "" } satisfies CompleteBlockState
  tokens.forEach((token) => appendCompleteToken(state, token))
  pushProse(state)
  return state.blocks
}

function complete(text: string): Block[] {
  if (!requiresCompletedProjection(text)) return [{ raw: text, src: text, mode: "full" }]
  return completeBlocks(Array.from(completeTokens(text)))
}

export async function projectCompleted(
  text: string,
  active: () => boolean,
  publish?: (projection: Projection) => void,
) {
  if (!requiresCompletedProjection(text))
    return { text, blocks: [{ raw: text, src: text, mode: "full" }] } satisfies Projection
  const referenced = text.includes("]:")
  const tokens: CompleteToken[] = []
  const state = { blocks: [], prefix: "", prose: "" } satisfies CompleteBlockState
  let published = false
  let count = 0
  for (const token of completeTokens(text)) {
    if (!active()) return
    if (referenced) tokens.push(token)
    else appendCompleteToken(state, token)
    count++
    if (count % 128 !== 0) continue
    if (!referenced && !published && state.blocks.length > 0) {
      published = true
      publish?.({ text, blocks: state.blocks.slice() })
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  if (!active()) return
  const blocks = referenced ? completeBlocks(tokens) : (pushProse(state), state.blocks)
  const result = { text, blocks } satisfies Projection
  publish?.(result)
  return result
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return complete(text)
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []
  for (let index = 0; index < tail; index++) {
    const token = tokens[index]
    if (!token || token.type === "space") continue
    let raw = token.raw
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) {
      index++
      const space = tokens[index]
      if (space) raw += space.raw
    }
    if (token.type === "code") {
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }]

  const code = last as Tokens.Code
  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]
  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }]
}

export function canReusePendingBlock(current: Pick<Block, "mode" | "raw"> | undefined, next: Block) {
  if (!current || current.mode !== next.mode) return false
  if (next.mode === "code") return next.raw.startsWith(current.raw)
  return current.raw === next.raw
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live || !previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
    return { text, blocks: stream(text, live) }
  return {
    text,
    blocks: [
      ...previous.blocks.slice(0, -1),
      {
        ...tail,
        raw: tail.raw + suffix,
        src: tail.src + suffix,
      },
    ],
  }
}
