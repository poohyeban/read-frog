import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { getContextRequirements, getTranslatePromptFromConfig } from "@/utils/prompts/translate"
import { buildWebPageHashComponents } from "../translation-plan"

const provider = {
  kind: "local",
  config: DEFAULT_CONFIG.providersConfig[0],
} as SerializableProviderRef
const lang = { sourceCode: "eng", targetCode: "cmn" } as const

describe("request prompt identity", () => {
  it("derives requirements from both templates, never from input text", () => {
    const config = {
      customPromptsConfig: {
        promptId: "test",
        patterns: [
          {
            id: "test",
            name: "Test",
            systemPrompt: "Use {{webTitle}}",
            prompt: "Translate {{input}} using {{webDescription}}",
          },
        ],
      },
    }
    expect(getContextRequirements(config)).toEqual({
      title: true,
      description: true,
      content: false,
      summary: false,
    })
    config.customPromptsConfig.patterns[0]!.prompt += " {{webContent}} {{webSummary}}"
    expect(getContextRequirements(config)).toEqual({
      title: true,
      description: true,
      content: true,
      summary: true,
    })
  })
  it("hashes the same rendered prompt snapshot the background receives", async () => {
    const config = {
      customPromptsConfig: structuredClone(DEFAULT_CONFIG.pageTranslation.customPromptsConfig),
    }
    const context = { webTitle: "Title", webSummary: "Summary", webContent: "Full content" }
    const components = buildWebPageHashComponents(
      "Hello",
      provider,
      lang,
      true,
      "plain",
      false,
      [],
      context,
      config,
    )
    const rendered = getTranslatePromptFromConfig(config, "Mandarin Chinese", "Hello", {
      context,
      isBatch: true,
      glossaryTerms: [],
    })
    // Use the same target language mapping as the execution adapter.
    const { LANG_CODE_TO_EN_NAME } = await import("@/utils/languages")
    const actual = getTranslatePromptFromConfig(config, LANG_CODE_TO_EN_NAME.cmn, "Hello", {
      context,
      isBatch: true,
      glossaryTerms: [],
    })
    expect(components).toContain(actual.systemPrompt)
    expect(components).toContain(actual.prompt)
    expect(rendered.prompt).toContain("Hello")
    const changed = buildWebPageHashComponents(
      "Hello",
      provider,
      lang,
      true,
      "html",
      true,
      [],
      context,
      config,
    )
    expect(changed).not.toEqual(components)
  })
})
