import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { mergeWithArrayOverwrite } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { buildFeatureProviderPatch, FEATURE_KEYS } from "@/utils/constants/feature-providers"
import {
  getSelectableProvidersForCapability,
  resolveProviderRefForCapability,
} from "@/utils/providers/provider-registry"
import { clearProviderAssignments, clearSelectionToolbarProvider } from "../helpers"

function removeProvider(config: typeof DEFAULT_CONFIG, id: string) {
  return configSchema.parse(
    mergeWithArrayOverwrite(config, {
      ...mergeWithArrayOverwrite(
        { selectionToolbar: clearSelectionToolbarProvider(id, config) },
        buildFeatureProviderPatch(clearProviderAssignments(id, config)),
      ),
      providersConfig: config.providersConfig.filter((p) => p.id !== id),
    }),
  )
}
describe("independent capability assignments", () => {
  it("accepts no configured services and preserves local settings when the last provider is deleted", () => {
    let config = structuredClone(DEFAULT_CONFIG)
    config.language.targetCode = "jpn"
    for (const { id } of [...config.providersConfig]) config = removeProvider(config, id)
    expect(config.providersConfig).toEqual([])
    expect(config.language.targetCode).toBe("jpn")
    expect(config.glossary).toEqual(DEFAULT_CONFIG.glossary)
    for (const key of FEATURE_KEYS)
      expect(resolveProviderRefForCapability(key, config.providersConfig, "")).toBeNull()
  })
  it("clears assignments on deletion instead of selecting another enabled service", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.tts.providerId = config.pageTranslation.providerId
    const next = removeProvider(config, config.pageTranslation.providerId)
    expect(next.providersConfig.length).toBeGreaterThan(0)
    expect(next.tts.providerId).toBe("")
    expect(next.pageTranslation.providerId).toBe("")
    expect(next.selectionToolbar.builtInActions.dictionary.providerId).toBe("")
  })
  it("filters audio capability without changing text translation choices", () => {
    const providers = DEFAULT_CONFIG.providersConfig
    expect(getSelectableProvidersForCapability("tts", providers).map((p) => p.provider)).toEqual([
      "openai",
      "openai-compatible",
    ])
    expect(
      getSelectableProvidersForCapability("transcription", providers).map((p) => p.provider),
    ).toEqual(["openai", "openai-compatible"])
    expect(getSelectableProvidersForCapability("pageTranslation", providers)).toHaveLength(5)
  })
  it("keeps audio models and provider choices independent of page translation", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.tts = {
      ...config.tts,
      providerId: "openai-compatible-default",
      model: "my-speech",
      defaultVoice: "voice",
    }
    config.transcription = {
      ...config.transcription,
      providerId: "openai-default",
      model: "my-asr",
    }
    const next = configSchema.parse(
      mergeWithArrayOverwrite(
        config,
        buildFeatureProviderPatch({ pageTranslation: "google-default" }),
      ),
    )
    expect(next.tts).toEqual(config.tts)
    expect(next.transcription).toEqual(config.transcription)
  })
  it("does not call a disabled provider", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.providersConfig[0]!.enabled = false
    expect(configSchema.safeParse(config).success).toBe(true)
    expect(
      resolveProviderRefForCapability(
        "pageTranslation",
        config.providersConfig,
        config.providersConfig[0]!.id,
      ),
    ).toBeNull()
  })
  it("adds unconfigured audio settings to old configs without changing credentials", () => {
    const { tts: _tts, transcription: _asr, ...legacy } = structuredClone(DEFAULT_CONFIG)
    legacy.providersConfig[0]!.apiKey = "private-test-key"
    const migrated = configSchema.parse(legacy)
    expect(migrated.tts.providerId).toBe("")
    expect(migrated.transcription.providerId).toBe("")
    expect(migrated.providersConfig).toEqual(legacy.providersConfig)
  })
})
