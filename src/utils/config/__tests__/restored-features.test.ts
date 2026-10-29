import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"

describe("Lite 0.1 configuration upgrade", () => {
  it("inherits the existing translation provider without resetting keys or language", () => {
    const legacy = structuredClone(DEFAULT_CONFIG)
    legacy.providersConfig = legacy.providersConfig.map((provider) => ({
      ...provider,
      id: `user-${provider.id}`,
      apiKey: "test-secret",
    }))
    legacy.language.targetCode = "jpn"
    legacy.pageTranslation.providerId = legacy.providersConfig[0]!.id
    legacy.selectionToolbar.features.translate.providerId = legacy.providersConfig[0]!.id
    Object.values(legacy.selectionToolbar.builtInActions).forEach((action) => {
      action.providerId = legacy.providersConfig[0]!.id
    })
    const {
      inputTranslation: _input,
      videoSubtitles: _video,
      floatingButton: _floating,
      glossary: _glossary,
      ...stored
    } = legacy
    const {
      customActions: _actions,
      order: _order,
      unpinned: _unpinned,
      ...toolbar
    } = stored.selectionToolbar
    const { improveWriting: _improve, ...builtInActions } = toolbar.builtInActions
    const upgraded = configSchema.parse({
      ...stored,
      selectionToolbar: { ...toolbar, builtInActions },
    })
    expect(upgraded.videoSubtitles.providerId).toBe(legacy.pageTranslation.providerId)
    expect(upgraded.inputTranslation.providerId).toBe(legacy.pageTranslation.providerId)
    expect(upgraded.providersConfig).toEqual(legacy.providersConfig)
    expect(upgraded.language.targetCode).toBe("jpn")
    expect(upgraded.selectionToolbar.customActions).toEqual([])
    expect(upgraded.glossary.enabled).toBe(true)
  })
})
