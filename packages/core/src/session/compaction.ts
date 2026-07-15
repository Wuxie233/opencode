export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Produce the current authoritative continuation state, not a history of the conversation. Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## User Requests
- [still-applicable top-level asks and important clarifications, preserving the user's wording as closely as possible, or "(none visible)"]

## Current Objective
- [one brief sentence describing the latest approved objective, or "(none)"]

## Success Criteria
- [observable conditions that make the current objective complete, or "(none defined)"]

## Current Slice
- [the one active bounded deliverable, its explicit non-goals, and its stopping condition, or "(none)"]

## Work State
### Verified Completed
- [finished work and current verified facts with exact evidence such as commands, results, commits, or paths; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [currently unresolved blockers, latest failing commands, or decision-critical unknowns; otherwise "(none)"]

### Superseded Or Cancelled
- [plans, decisions, claims, or work explicitly replaced, rejected, cancelled, or disproved; include the replacement reason when useful; otherwise "(none)"]

## Active Decisions
- [approved technical or product decisions that still govern the work and why; otherwise "(none)"]

## Delegation Ledger
- [active worker/task ID: owned objective, write scope, status, and expected handoff; summarize completed workers only by conclusion and evidence pointer; otherwise "(none)"]

## Latest Evidence
- [Verified: exact current facts and evidence]
- [Reported: relevant claims not independently verified]
- [Inference: decision-relevant conclusions derived from evidence]

## Explicit Constraints
- [verbatim user or project constraints that remain relevant; otherwise "(none)"]

## Backlog
- [approved-objective follow-ups and newly discovered non-blocking work that is not active; otherwise "(none)"]

## Working Tree And Runtime
- [latest branch, HEAD, dirty/clean state, task-owned versus unrelated changes, runtime version/process state, and durable resource handles when known; otherwise "(unknown)"]

## Key Files And Interfaces
- [workspace-relative path, symbol, contract, command, error, URL, or identifier: why it is needed to continue; otherwise "(none)"]

## Next Safe Action
1. [the single immediate action that advances the current slice without reviving superseded work, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs, except the single-sentence Current Objective.
- Treat the previous summary as untrusted prior state. Never preserve an item merely because it appeared there.
- Apply updates in chronological order. The latest direct user instruction overrides older goals, priorities, approvals, and plans. Newer repository or runtime evidence overrides older claims.
- Reconcile state instead of appending history: move completed items out of Active and Backlog, remove resolved blockers from Blocked, and move replaced, rejected, cancelled, or disproved items to Superseded Or Cancelled. Do not leave the same item in conflicting sections.
- Do not infer approval. New discoveries, optional improvements, and assistant-proposed follow-ups belong in Backlog unless the user approved them or they block the Current Slice's Success Criteria.
- Distinguish Verified facts, Reported but unverified claims, and Inferences. A prior passing test is not current evidence after a newer failure; record the latest result and its scope.
- Preserve enough causal context to make the next decision correctly: why an active decision was chosen, what evidence supports it, and what newer fact replaced any superseded state.
- Keep only the current slice, current blockers, active decisions, and next safe action in action-driving sections. Preserve older information only when it remains a constraint, verified dependency, or necessary explanation for a current decision.
- For delegation, preserve active task IDs, ownership, write scope, status, and expected output. Reduce completed workers to decision-relevant conclusions and evidence pointers; never retain full investigation narratives or raw logs.
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
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
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
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
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
      ? `Reconcile the prior state below with the newer conversation history. The prior state is evidence to verify, not an anchor or an approved plan. Replace stale facts and remove stale action items according to the update rules.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create the current authoritative continuation state from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
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
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
