import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getSubtitlesTranslatePromptFromConfig } from "@/utils/prompts/subtitles"
import { createSubtitleTranslationPlan } from "../translation-plan"
const input = () => ({
  text: "hello",
  langConfig: structuredClone(DEFAULT_CONFIG.language),
  providerRef: {
    kind: "local" as const,
    config: { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai) },
  },
  promptConfig: structuredClone(DEFAULT_CONFIG.videoSubtitles),
  scheduleAt: 0,
  summary: "context version A",
  glossaryTerms: [],
})
describe("subtitle immutable request plan", () => {
  it("separates execution scope from semantic cache identity", () => {
    const a = createSubtitleTranslationPlan(
      { ...input(), sessionId: "playback" },
      { videoId: "A", trackId: "en", revision: 1, cueKey: "first" },
    )
    const b = createSubtitleTranslationPlan({ ...input(), sessionId: "export", scheduleAt: 123 })
    expect(a.request.hash).toBe(b.request.hash)
    expect(a.source?.videoId).toBe("A")
    expect(Object.isFrozen(a.request.providerRef.config)).toBe(true)
  })
  it("captures provider/template/terms/summary and is unaffected by later mutation", () => {
    const data = input()
    const plan = createSubtitleTranslationPlan(data)
    data.providerRef.config.name = "edited provider"
    data.summary = "context version B"
    data.langConfig.targetCode = "jpn"
    const changed = createSubtitleTranslationPlan(data)
    expect(plan.request.summary).toBe("context version A")
    expect(plan.request.hash).not.toBe(changed.request.hash)
    expect(plan.request.providerRef.config.name).not.toBe("edited provider")
  })
  it("pure prompt rendering preserves built-in rules and context without storage", () => {
    const data = input()
    const result = getSubtitlesTranslatePromptFromConfig(data.promptConfig, "Chinese", "hello", {
      isBatch: true,
      context: { videoSummary: "Known summary", webTitle: "Title", webDescription: "Description" },
      glossaryTerms: [],
    })
    expect(result.systemPrompt.length).toBeGreaterThan(50)
    expect(result.prompt).toContain("hello")
    expect(result.prompt + result.systemPrompt).toContain("Known summary")
  })
})
