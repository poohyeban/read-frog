import type { Config } from "@/types/config/config"
import { Sha256Hex } from "@/utils/hash"

/** Rendering-only edits do not restart translation. Never persist or log provider credentials. */
export function subtitleConfigIdentity(config: Config | null): string {
  return Sha256Hex(
    subtitleCacheIdentity(config),
    String(config?.providersConfig.find((p) => p.id === config.videoSubtitles.providerId)?.enabled),
  )
}

/** Admission and display settings cannot invalidate already completed translations. */
export function subtitleCacheIdentity(config: Config | null): string {
  const selected = config?.providersConfig.find((p) => p.id === config.videoSubtitles.providerId)
  const provider = selected
    ? Object.fromEntries(
        Object.entries(selected).filter(([key]) => !["name", "enabled"].includes(key)),
      )
    : null
  return Sha256Hex(
    JSON.stringify(
      config
        ? {
            provider,
            language: config.language,
            prompt: config.videoSubtitles.customPromptsConfig,
            segmentation: config.videoSubtitles.aiSegmentation,
            context: config.pageTranslation?.enableAIContentAware,
            glossary: config.glossary?.enabled,
          }
        : null,
    ),
  )
}

/** Exact legacy lookup only. Unknown old configurations must never be guessed. */
export function legacySubtitleConfigIdentity(config: Config | null): string {
  return Sha256Hex(
    JSON.stringify(
      config
        ? {
            providers: config.providersConfig,
            providerId: config.videoSubtitles.providerId,
            language: config.language,
            prompt: config.videoSubtitles.customPromptsConfig,
            segmentation: config.videoSubtitles.aiSegmentation,
            context: config.pageTranslation?.enableAIContentAware,
            glossary: config.glossary?.enabled,
          }
        : null,
    ),
  )
}
