import type { Config } from "@/types/config/config"
import { Sha256Hex } from "@/utils/hash"

/** Rendering-only edits do not restart translation. Never persist or log provider credentials. */
export function subtitleConfigIdentity(config: Config | null): string {
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
