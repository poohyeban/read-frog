import type { Config } from "@/types/config/config"
import type { PerformanceOverrides } from "@/utils/request/performance-config"
import { storage } from "#imports"
import {
  emptyPerformanceOverrides,
  PERFORMANCE_STORAGE_KEY,
  performanceOverridesSchema,
  subtitlePerformanceSchema,
} from "@/utils/request/performance-config"
import { resourcePolicySchema } from "@/utils/request/resource-policy"

// Historical defaults must not move when new benchmark results tune current defaults.
const LEGACY_V5_RESOURCE_DEFAULTS = { rate: 8, capacity: 20, maxInFlight: 2 }
const LEGACY_V5_BATCH_DEFAULTS = { maxItemsPerBatch: 4, maxCharactersPerBatch: 1000 }

/** Run before the root schema strips workBudget. Never overwrite a newer sparse value. */
interface LegacyScheduling {
  requestQueueConfig?: { rate?: number; capacity?: number }
  batchQueueConfig?: { maxItemsPerBatch?: number; maxCharactersPerBatch?: number }
}
type LegacyConfig = Omit<Config, "pageTranslation" | "videoSubtitles"> & {
  pageTranslation: Config["pageTranslation"] & LegacyScheduling
  videoSubtitles: Config["videoSubtitles"] & LegacyScheduling
}
export async function migratePerformanceConfig(config: LegacyConfig, oldVersion: number) {
  if (oldVersion >= 6) return
  const stored = await storage.getItem<PerformanceOverrides>(PERFORMANCE_STORAGE_KEY)
  const parsed = performanceOverridesSchema.safeParse(stored)
  const next = parsed.success ? parsed.data : emptyPerformanceOverrides()
  const before = JSON.stringify(next)
  const knownDefaults = oldVersion >= 5
  for (const [feature, owner] of [
    ["page", config.pageTranslation],
    ["subtitles", config.videoSubtitles],
  ] as const) {
    if (!owner) continue
    for (const key of ["rate", "capacity"] as const) {
      const value = owner.requestQueueConfig?.[key]
      if (
        typeof value !== "number" ||
        !resourcePolicySchema.shape[key].safeParse(value).success ||
        (knownDefaults && value === LEGACY_V5_RESOURCE_DEFAULTS[key])
      )
        continue
      next.providers ??= {}
      const provider = (next.providers[owner.providerId] ??= {})
      // A shared account must accommodate a pre-existing higher explicit setting.
      if (!stored?.providers?.[owner.providerId]?.[key])
        provider[key] = Math.max(provider[key] ?? 0, value)
    }
    for (const key of ["maxItemsPerBatch", "maxCharactersPerBatch"] as const) {
      const value = owner.batchQueueConfig?.[key]
      const max = key === "maxItemsPerBatch" ? 32 : 12_000
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > max ||
        (knownDefaults && value === LEGACY_V5_BATCH_DEFAULTS[key])
      )
        continue
      next.batches ??= {}
      const batch = (next.batches[feature] ??= {})
      batch[key] ??= value
    }
  }
  const legacy = (
    config.videoSubtitles as Config["videoSubtitles"] & {
      workBudget?: { maxInFlight?: number; diagnostics?: boolean }
    }
  )?.workBudget
  if (
    legacy?.maxInFlight !== undefined &&
    resourcePolicySchema.shape.maxInFlight.safeParse(legacy.maxInFlight).success &&
    (!knownDefaults || legacy.maxInFlight !== LEGACY_V5_RESOURCE_DEFAULTS.maxInFlight)
  ) {
    next.providers ??= {}
    const provider = (next.providers[config.videoSubtitles.providerId] ??= {})
    provider.maxInFlight ??= legacy.maxInFlight
  }
  if (
    legacy?.diagnostics !== undefined &&
    subtitlePerformanceSchema.shape.diagnostics.safeParse(legacy.diagnostics).success &&
    (!knownDefaults || legacy.diagnostics)
  ) {
    next.subtitles ??= {}
    next.subtitles.diagnostics ??= legacy.diagnostics
  }
  if (JSON.stringify(next) !== before) {
    next.revision++
    await storage.setItem(PERFORMANCE_STORAGE_KEY, next)
  }
}
