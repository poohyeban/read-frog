import { z } from "zod"
import {
  GLOBAL_RESOURCE_DEFAULTS,
  RESOURCE_DEFAULTS,
  resourcePolicySchema,
  SUBTITLE_PERFORMANCE_DEFAULTS,
} from "./resource-policy"

export const PERFORMANCE_STORAGE_KEY = "local:performanceOverrides" as const
export const BATCH_DEFAULTS = Object.freeze({
  maxItemsPerBatch: 4,
  maxCharactersPerBatch: 1000,
  batchDelay: 100,
  maxPending: 128,
})
export const batchOverridesSchema = z.object({
  maxItemsPerBatch: z.number().int().min(1).max(32).optional(),
  maxCharactersPerBatch: z.number().int().min(1).max(12_000).optional(),
  batchDelay: z.number().int().min(0).max(500).optional(),
  maxPending: z.number().int().min(1).max(1024).optional(),
})
export type BatchPerformance = Required<z.infer<typeof batchOverridesSchema>>
export const subtitlePerformanceSchema = z.object({
  diagnostics: z.boolean(),
  maxPendingBatches: z.number().int().min(1).max(16),
  batchSize: z.number().int().min(1).max(32),
  fastAheadMs: z.number().int().min(1000).max(120_000),
  qualityAheadMs: z.number().int().min(1000).max(300_000),
  lowMinMs: z.number().int().min(1000).max(60_000),
  lowMaxMs: z.number().int().min(1000).max(120_000),
  highMinMs: z.number().int().min(2000).max(180_000),
  highMaxMs: z.number().int().min(2000).max(300_000),
})
export const performanceOverridesSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0),
  global: z
    .object({
      maxInFlight: z.number().int().min(1).max(128).optional(),
      maxQueued: z.number().int().min(1).max(4096).optional(),
    })
    .optional(),
  providers: z.record(z.string(), resourcePolicySchema.partial()).optional(),
  groups: z
    .record(
      z.string(),
      z.object({
        name: z.string().trim().min(1).max(80),
        members: z.array(z.string().min(1).max(128)).min(1).max(128),
        policy: resourcePolicySchema.partial().optional(),
      }),
    )
    .optional(),
  batches: z
    .object({ page: batchOverridesSchema.optional(), subtitles: batchOverridesSchema.optional() })
    .optional(),
  subtitles: subtitlePerformanceSchema.partial().optional(),
})
export type PerformanceOverrides = z.infer<typeof performanceOverridesSchema>
export type SubtitlePerformance = z.infer<typeof subtitlePerformanceSchema>
export const emptyPerformanceOverrides = (): PerformanceOverrides => ({ version: 1, revision: 0 })

export function validatePerformanceOverrides(value: unknown): PerformanceOverrides {
  const parsed = performanceOverridesSchema.parse(value)
  const owners = new Set<string>()
  for (const group of Object.values(parsed.groups ?? {})) {
    for (const member of group.members) {
      if (owners.has(member))
        throw new Error("A physical resource can belong to only one shared group")
      owners.add(member)
    }
  }
  for (const policy of [
    ...Object.values(parsed.providers ?? {}).filter(
      (candidate) =>
        candidate.maxRetryDelayMs !== undefined && candidate.baseRetryDelayMs !== undefined,
    ),
    ...Object.values(parsed.groups ?? {}).map((g) => g.policy ?? {}),
  ]) {
    if (
      (policy.maxRetryDelayMs ?? RESOURCE_DEFAULTS.maxRetryDelayMs) <
      (policy.baseRetryDelayMs ?? RESOURCE_DEFAULTS.baseRetryDelayMs)
    )
      throw new Error("Maximum retry delay must be at least the base retry delay")
  }
  const s = { ...SUBTITLE_PERFORMANCE_DEFAULTS, ...parsed.subtitles }
  if (
    s.lowMinMs > s.lowMaxMs ||
    s.highMinMs > s.highMaxMs ||
    s.highMinMs <= s.lowMinMs ||
    s.highMaxMs <= s.lowMaxMs
  )
    throw new Error("Buffer high watermarks must exceed low watermarks")
  return parsed
}

export function effectivePerformance(
  overrides: PerformanceOverrides = emptyPerformanceOverrides(),
) {
  return {
    global: { ...GLOBAL_RESOURCE_DEFAULTS, ...overrides.global },
    batches: {
      page: { ...BATCH_DEFAULTS, ...overrides.batches?.page },
      subtitles: { ...BATCH_DEFAULTS, ...overrides.batches?.subtitles },
    },
    subtitles: { ...SUBTITLE_PERFORMANCE_DEFAULTS, ...overrides.subtitles },
  }
}

/** Export tuning without installation-bound physical identities or HMAC material. */
export function portablePerformanceOverrides(overrides: PerformanceOverrides) {
  return {
    ...overrides,
    groups: overrides.groups
      ? Object.fromEntries(
          Object.entries(overrides.groups).map(([id, group]) => [
            id,
            {
              name: group.name,
              policy: group.policy,
              bindingsOmitted: true,
            },
          ]),
        )
      : undefined,
  }
}
