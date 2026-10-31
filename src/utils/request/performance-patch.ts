import type { PerformanceOverrides } from "./performance-config"
import { z } from "zod"
import {
  BATCH_DEFAULTS,
  batchOverridesSchema,
  subtitlePerformanceSchema,
  validatePerformanceOverrides,
} from "./performance-config"
import {
  GLOBAL_RESOURCE_DEFAULTS,
  RESOURCE_DEFAULTS,
  resourcePolicySchema,
  SUBTITLE_PERFORMANCE_DEFAULTS,
} from "./resource-policy"

const fieldValue = z.union([z.number().finite(), z.boolean(), z.null()])
const scope = z.discriminatedUnion("section", [
  z.object({ section: z.literal("global") }),
  z.object({ section: z.literal("provider"), id: z.string().min(1) }),
  z.object({ section: z.literal("group"), id: z.string().min(1) }),
  z.object({ section: z.literal("batch"), id: z.enum(["page", "subtitles"]) }),
  z.object({ section: z.literal("subtitles") }),
])
export const performancePatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reset-all") }),
  z.object({ kind: z.literal("set"), target: scope, field: z.string(), value: fieldValue }),
  z.object({ kind: z.literal("reset"), target: scope }),
  z.object({
    kind: z.literal("create-group"),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    members: z.array(z.string()).min(1).max(128),
  }),
  z
    .object({
      kind: z.literal("edit-group"),
      id: z.string(),
      name: z.string().trim().min(1).max(80).optional(),
      addMembers: z.array(z.string().min(1).max(128)).max(128).optional(),
      removeMembers: z.array(z.string().min(1).max(128)).max(128).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("delete-group"), id: z.string() }),
])
export type PerformancePatch = z.infer<typeof performancePatchSchema>
export type PerformanceTarget = z.infer<typeof scope>

function compact(object: Record<string, unknown>) {
  for (const [key, value] of Object.entries(object)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    compact(value as Record<string, unknown>)
    if (!Object.keys(value).length) delete object[key]
  }
}

/** Apply only explicitly edited fields. Readers and defaults never call this function. */
export function applyPerformancePatch(
  current: PerformanceOverrides,
  input: PerformancePatch,
  identities: ReadonlyMap<string, string>,
  providerIds: ReadonlySet<string>,
): PerformanceOverrides | null {
  const patch = performancePatchSchema.parse(input)
  const next = structuredClone(current)
  if (patch.kind === "reset-all") {
    for (const key of ["providers", "groups", "batches", "subtitles", "global"] as const)
      delete next[key]
  } else if (patch.kind === "create-group" || patch.kind === "edit-group") {
    const available = new Set(identities.values())
    const added = patch.kind === "create-group" ? patch.members : (patch.addMembers ?? [])
    if (added.some((id) => !available.has(id)))
      throw new Error("Resource identity changed; reload the available providers")
    const group = next.groups?.[patch.id]
    if ((patch.kind === "create-group") === Boolean(group))
      throw new Error("Resource group changed; reload settings")
    next.groups ??= {}
    if (patch.kind === "create-group")
      next.groups[patch.id] = { name: patch.name, members: [...new Set(added)] }
    else {
      const removed = new Set(patch.removeMembers ?? [])
      if (added.some((id) => removed.has(id)))
        throw new Error("Cannot add and remove the same resource")
      // Apply intent to the latest persisted group. Renames and stale editor
      // snapshots must not overwrite another editor's membership or policy.
      next.groups[patch.id] = {
        ...group!,
        name: patch.name ?? group!.name,
        members: [...new Set([...group!.members.filter((id) => !removed.has(id)), ...added])],
      }
    }
  } else if (patch.kind === "delete-group") {
    delete next.groups?.[patch.id]
  } else {
    const target = patch.target
    let fields: Record<string, unknown>
    let defaults: Record<string, number | boolean>
    let schema: z.ZodObject
    switch (target.section) {
      case "global":
        fields = next.global ??= {}
        defaults = GLOBAL_RESOURCE_DEFAULTS
        schema = z.object({
          maxInFlight: z.number().int().min(1).max(128),
          maxQueued: z.number().int().min(1).max(4096),
        })
        break
      case "provider": {
        if (!providerIds.has(target.id)) throw new Error("Provider no longer exists")
        fields = (next.providers ??= {})[target.id] ??= {}
        const physical = identities.get(target.id)
        const group = physical
          ? Object.values(next.groups ?? {}).find((g) => g.members.includes(physical))
          : undefined
        defaults = { ...RESOURCE_DEFAULTS, ...group?.policy }
        schema = resourcePolicySchema
        break
      }
      case "group": {
        const group = next.groups?.[target.id]
        if (!group) throw new Error("Resource group no longer exists")
        fields = group.policy ??= {}
        defaults = RESOURCE_DEFAULTS
        schema = resourcePolicySchema
        break
      }
      case "batch":
        fields = (next.batches ??= {})[target.id] ??= {}
        defaults = BATCH_DEFAULTS
        schema = batchOverridesSchema
        break
      case "subtitles":
        fields = next.subtitles ??= {}
        defaults = SUBTITLE_PERFORMANCE_DEFAULTS
        schema = subtitlePerformanceSchema
        break
      default:
        throw new Error("Unknown resource setting scope")
    }
    if (patch.kind === "reset") for (const key of Object.keys(fields)) delete fields[key]
    else {
      if (!(patch.field in defaults)) throw new Error("Unknown resource setting")
      if (patch.value === null || patch.value === defaults[patch.field]) delete fields[patch.field]
      else {
        const candidate = { ...defaults, [patch.field]: patch.value }
        schema.parse(candidate)
        fields[patch.field] = patch.value
      }
    }
  }
  compact(next)
  const validated = validatePerformanceOverrides(next)
  if (JSON.stringify(validated) === JSON.stringify(current)) return null
  validated.revision = current.revision + 1
  return validated
}
