import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { subtitleCacheIdentity, subtitleConfigIdentity } from "../config-identity"

describe("semantic subtitle cache identity", () => {
  it("survives renaming, disablement, grouping and unrelated provider edits", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.videoSubtitles.providerId = config.providersConfig[0]!.id
    const before = subtitleCacheIdentity(config)
    const running = subtitleConfigIdentity(config)
    config.providersConfig[0]!.name = "renamed"
    expect(subtitleConfigIdentity(config)).toBe(running)
    config.providersConfig[0]!.enabled = !config.providersConfig[0]!.enabled
    expect(subtitleCacheIdentity(config)).toBe(before)
    expect(subtitleConfigIdentity(config)).not.toBe(running)
    config.providersConfig[1]!.name = "other"
    expect(subtitleCacheIdentity(config)).toBe(before)
  })
  it("isolates provider selection, language, segmentation and prompts", () => {
    const original = structuredClone(DEFAULT_CONFIG)
    for (const mutate of [
      (config: typeof original) => {
        config.videoSubtitles.providerId = "another"
      },
      (config: typeof original) => {
        config.language.targetCode = "jpn"
      },
      (config: typeof original) => {
        config.videoSubtitles.aiSegmentation = !config.videoSubtitles.aiSegmentation
      },
      (config: typeof original) => {
        config.pageTranslation.enableAIContentAware = !config.pageTranslation.enableAIContentAware
      },
    ]) {
      const config = structuredClone(original)
      mutate(config)
      expect(subtitleCacheIdentity(config)).not.toBe(subtitleCacheIdentity(original))
    }
  })
})
