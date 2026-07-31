export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMClientShape, type LLMRequest, type Model } from "@opencode-ai/llm"
import type { RequestExecutor } from "@opencode-ai/llm/route"
import type { OpenAIResponsesBody } from "@opencode-ai/llm/protocols/openai-responses"
import { OpenAIResponsesCompact } from "@opencode-ai/llm/protocols/openai-responses-compact"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionCanonicalWindow } from "./canonical-window"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const PROVIDER_COMPACTION_TIMEOUT = "5 minutes"
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## User Requests
- [top-level user asks and important clarifications, preserving wording as closely as possible, or "(none visible)"]

## Goal
- [one brief sentence describing what should be done next]

## Work State
### Completed
- [finished work, verified facts, changes made, and test/build results; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Pending Tasks
- [remaining concrete tasks or next logical actions; otherwise "(none)"]

## Key Files
- [workspace-relative file or directory path: why it matters, or "(none)"]

## Important Decisions
- [technical decisions, constraints, preferences, trade-offs, and why; otherwise "(none)"]

## Explicit Constraints
- [verbatim user or project constraints that remain relevant; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Continuation Context
- [warnings, gotchas, exact context needed to continue, relevant commands, errors, URLs, or identifiers; otherwise "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs, except the single-sentence Goal.
- Preserve exact file paths, symbols, commands, error strings, URLs, identifiers, decisions, verification results, and user constraints when known.
- Use workspace-relative paths for files when possible.
- Do not include secrets, API keys, tokens, cookies, or credentials.
- Do not claim tests or builds passed unless the history shows that they did.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly mode: "provider" | "local"
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly prepare: LLMClientShape["prepare"]
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly executor: RequestExecutor.Interface
  readonly db: Database.Interface["db"]
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  readonly variant?: string
  readonly canonicalSourceSeq?: number
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      mode: current.mode ?? result.mode,
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { mode: "provider", auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].slice(0, -remaining)
        splitSuffix = conversation[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...conversation.slice(0, split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split)].filter(Boolean).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const providerCompact = Effect.fn("SessionCompaction.providerCompact")(function* (input: Input) {
    if (config.mode === "local" || !OpenAIResponsesCompact.supported(input.model)) return false
    const sourceSeq = input.entries.at(-1)?.seq
    if (sourceSeq === undefined) return false
    if (input.canonicalSourceSeq !== undefined && sourceSeq <= input.canonicalSourceSeq) return false
    return yield* Effect.gen(function* () {
      const prepared = yield* dependencies.llm.prepare<OpenAIResponsesBody>(input.request)
      const compacted = yield* OpenAIResponsesCompact.compact({
        request: input.request,
        body: {
          model: prepared.body.model,
          input: prepared.body.input,
          instructions: prepared.body.instructions,
          prompt_cache_key: prepared.body.prompt_cache_key,
          service_tier: prepared.body.service_tier,
        },
        executor: dependencies.executor,
      })
      yield* SessionCanonicalWindow.replace(dependencies.db, {
        sessionID: input.sessionID,
        providerID: input.model.provider,
        modelID: input.model.id,
        routeID: input.model.route.id,
        variant: input.variant,
        sourceSeq,
        items: compacted.output,
      })
      return true
    }).pipe(
      Effect.timeout(PROVIDER_COMPACTION_TIMEOUT),
      Effect.catch(() => Effect.succeed(false)),
    )
  })
  const localCompact = Effect.fn("SessionCompaction.localCompact")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    yield* SessionCanonicalWindow.clear(dependencies.db, input.sessionID).pipe(Effect.catch(() => Effect.void))
    return true
  })
  const compact = Effect.fn("SessionCompaction.compact")(function* (input: Input) {
    if (yield* providerCompact(input)) return true
    return yield* localCompact(input)
  })
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    return yield* compact(input)
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({
        system: input.request.system,
        messages: input.request.messages,
        tools: input.request.tools,
        canonical: input.request.providerOptions?.openai?.canonicalInput,
      }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compact(input)
  })
  return {
    compact,
    compactIfNeeded,
    compactAfterOverflow,
  }
}
