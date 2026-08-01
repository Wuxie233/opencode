import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { it } from "../lib/effect"

const build = AgentV2.ID.make("build")
const effect = SkillV2.Info.make({
  name: "effect",
  description: "Build applications with Effect",
  location: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const hidden = SkillV2.Info.make({
  name: "hidden",
  location: AbsolutePath.make(path.resolve("/skills/hidden/SKILL.md")),
  content: "Undescribed guidance",
})
const denied = SkillV2.Info.make({
  name: "denied",
  description: "Must not be advertised",
  location: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
  content: "Denied guidance",
})
const router = SkillV2.Info.make({
  name: "router",
  description: "Route specialized skills",
  location: AbsolutePath.make(path.resolve("/skills/router/SKILL.md")),
  content: "Router guidance",
})
const child = SkillV2.Info.make({
  name: "child",
  description: "Specialized child",
  routers: ["router"],
  location: AbsolutePath.make(path.resolve("/skills/child/SKILL.md")),
  content: "Child guidance",
})
const explicit = SkillV2.Info.make({
  name: "explicit",
  description: "Only load by exact name",
  exposure: "explicit",
  location: AbsolutePath.make(path.resolve("/skills/explicit/SKILL.md")),
  content: "Explicit guidance",
})
const orphan = SkillV2.Info.make({
  name: "orphan",
  description: "Promoted when its router is unavailable",
  routers: ["missing-router"],
  location: AbsolutePath.make(path.resolve("/skills/orphan/SKILL.md")),
  content: "Orphan guidance",
})

const layer = (list: () => SkillV2.Info[]) =>
  AppNodeBuilder.build(SkillGuidance.node, [
    [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed(list()) })],
  ])

describe("SkillGuidance", () => {
  it.effect("renders described agent skills and reconciles the complete available list", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let skills = [hidden, denied, effect]
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))

      expect(initialized.baseline).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          "    <name>effect</name>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )

      skills = []
      expect(
        yield* guidance
          .load({ id: agent.id, info: agent })
          .pipe(Effect.flatMap((context) => SystemContext.reconcile(context, initialized.snapshot))),
      ).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("advertises roots and promotes children whose router is denied", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "router", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const baseline = (
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))
      ).baseline
      expect(baseline).not.toContain("<name>router</name>")
      expect(baseline).not.toContain("<name>explicit</name>")
      expect(baseline).toContain("<name>child</name>")
      expect(baseline).toContain("<name>orphan</name>")
    }).pipe(Effect.provide(layer(() => [router, child, explicit, orphan])))
  })

  it.effect("keeps reachable routed and explicit skills out of root guidance", () => {
    const agent = AgentV2.Info.empty(build)
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const baseline = (
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))
      ).baseline
      expect(baseline).toContain("<name>router</name>")
      expect(baseline).toContain("<name>orphan</name>")
      expect(baseline).not.toContain("<name>child</name>")
      expect(baseline).not.toContain("<name>explicit</name>")
    }).pipe(Effect.provide(layer(() => [router, child, explicit, orphan])))
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a resource-specific denial follows the global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "hidden", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toContain("<name>effect</name>")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a specifically allowed skill is denied again", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })
})
