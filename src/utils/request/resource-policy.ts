import { z } from "zod"

/** These are tunable defaults, not per-business copies of physical limits. */
export const RESOURCE_DEFAULTS = Object.freeze({
  rate: 8,
  capacity: 20,
  maxInFlight: 2,
  maxQueued: 64,
  timeoutMs: 120_000,
  maxAttempts: 3,
  baseRetryDelayMs: 1000,
  maxRetryDelayMs: 30_000,
  cooldownMs: 5000,
  priorityAgingMs: 30_000,
})
export const GLOBAL_RESOURCE_DEFAULTS = Object.freeze({ maxInFlight: 8, maxQueued: 256 })
export const SUBTITLE_PERFORMANCE_DEFAULTS = Object.freeze({
  diagnostics: false,
  maxPendingBatches: 2,
  batchSize: 5,
  cacheRestoreTimeoutMs: 250,
  cacheRestoreRetryMs: 5000,
  fastAheadMs: 30_000,
  qualityAheadMs: 60_000,
  lowMinMs: 8000,
  lowMaxMs: 30_000,
  highMinMs: 20_000,
  highMaxMs: 60_000,
})

export const resourcePolicySchema = z.object({
  rate: z.number().min(0.01).max(100),
  capacity: z.number().int().min(1).max(100),
  maxInFlight: z.number().int().min(1).max(32),
  maxQueued: z.number().int().min(1).max(1024),
  timeoutMs: z.number().int().min(1000).max(300_000),
  maxAttempts: z.number().int().min(1).max(10),
  baseRetryDelayMs: z.number().int().min(100).max(30_000),
  maxRetryDelayMs: z.number().int().min(100).max(300_000),
  cooldownMs: z.number().int().min(100).max(300_000),
  priorityAgingMs: z.number().int().min(1000).max(300_000),
})
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>
export type ResourcePolicyOverrides = Partial<ResourcePolicy>

export function resolveResourcePolicy(overrides: ResourcePolicyOverrides = {}): ResourcePolicy {
  const result = resourcePolicySchema.parse({ ...RESOURCE_DEFAULTS, ...overrides })
  if (result.maxRetryDelayMs < result.baseRetryDelayMs)
    throw new Error("Maximum retry delay must be at least the base retry delay")
  return result
}
