import { describe, expect, it } from "vitest"
import {
  getProviderOptions,
  getProviderOptionsWithOverride,
  getRecommendedProviderOptionsMatch,
} from "../../providers/options"
import { LLM_PROVIDER_MODELS } from "../models"

describe("getProviderOptions", () => {
  describe("model pattern matching", () => {
    it("should return options for gemini models", () => {
      const options = getProviderOptions("gemini-2.5-pro", "google")
      expect(options.google).toBeDefined()
      expect(options.google?.thinkingConfig).toMatchObject({
        thinkingBudget: 0,
        includeThoughts: false,
      })

      const mixedCaseOptions = getProviderOptions("Gemini-2.5-Pro", "google")
      expect(mixedCaseOptions.google?.thinkingConfig).toMatchObject({
        thinkingBudget: 0,
        includeThoughts: false,
      })
    })

    it("should handle thinking models correctly", () => {
      const thinkingOptions = getProviderOptions("gemini-2.5-pro", "google")
      expect(thinkingOptions.google?.thinkingConfig).toMatchObject({ thinkingBudget: 0 })

      const nonThinkingOptions = getProviderOptions("gemini-2.5-flash", "google")
      expect(nonThinkingOptions.google?.thinkingConfig).toMatchObject({ thinkingBudget: 0 })

      const thinkingLevelFlashOptions = getProviderOptions("gemini-3-flash-preview", "google")
      expect(thinkingLevelFlashOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "minimal",
        includeThoughts: false,
      })

      const thinkingLevelProOptions = getProviderOptions("gemini-3-pro-preview", "google")
      expect(thinkingLevelProOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "low",
        includeThoughts: false,
      })

      const thinkingLevel31ProOptions = getProviderOptions("gemini-3.1-pro-preview", "google")
      expect(thinkingLevel31ProOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "low",
        includeThoughts: false,
      })

      const thinkingLevel31FlashLiteOptions = getProviderOptions(
        "gemini-3.1-flash-lite-preview",
        "google",
      )
      expect(thinkingLevel31FlashLiteOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "minimal",
        includeThoughts: false,
      })

      const thinkingLevel35FlashOptions = getProviderOptions("gemini-3.5-flash", "google")
      expect(thinkingLevel35FlashOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "minimal",
        includeThoughts: false,
      })

      const thinkingLevel35FlashLiteOptions = getProviderOptions("gemini-3.5-flash-lite", "google")
      expect(thinkingLevel35FlashLiteOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "minimal",
        includeThoughts: false,
      })

      const thinkingLevel36FlashOptions = getProviderOptions("gemini-3.6-flash", "google")
      expect(thinkingLevel36FlashOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "minimal",
        includeThoughts: false,
      })

      const thinkingLevelFlashLatestOptions = getProviderOptions("gemini-flash-latest", "google")
      expect(thinkingLevelFlashLatestOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "low",
        includeThoughts: false,
      })

      const thinkingLevelFlashLiteLatestOptions = getProviderOptions(
        "gemini-flash-lite-latest",
        "google",
      )
      expect(thinkingLevelFlashLiteLatestOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "minimal",
        includeThoughts: false,
      })

      const thinkingLevelProLatestOptions = getProviderOptions("gemini-pro-latest", "google")
      expect(thinkingLevelProLatestOptions.google?.thinkingConfig).toMatchObject({
        thinkingLevel: "low",
        includeThoughts: false,
      })
    })

    it("should return options for OpenAI o1/o3/o4 reasoning models", () => {
      const o1Options = getProviderOptions("o1-preview", "openai")
      expect(o1Options.openai?.reasoningEffort).toBe("minimal")

      const o3Options = getProviderOptions("o3-mini", "openai")
      expect(o3Options.openai?.reasoningEffort).toBe("minimal")

      const o4MiniOptions = getProviderOptions("o4-mini", "openai")
      expect(o4MiniOptions.openai?.reasoningEffort).toBe("minimal")

      const mixedCaseO4MiniOptions = getProviderOptions("O4-Mini", "openai")
      expect(mixedCaseO4MiniOptions.openai?.reasoningEffort).toBe("minimal")
    })

    it("should expose the supported OpenAI GPT-5.5 and GPT-5.4 model ids", () => {
      expect(LLM_PROVIDER_MODELS.openai).toEqual(
        expect.arrayContaining([
          "gpt-5.5",
          "gpt-5.4-pro",
          "gpt-5.4",
          "gpt-5.4-mini",
          "gpt-5.4-nano",
          "gpt-5.3-chat-latest",
        ]),
      )
    })

    it("should expose current Ollama recommended model ids", () => {
      expect(LLM_PROVIDER_MODELS.ollama).toEqual([
        "gemma4:e2b",
        "gemma4:e4b",
        "gemma3:4b",
        "llama3.2:3b",
      ])
    })

    it("should return the documented floor for GPT-5 model-specific reasoning", () => {
      const gpt55Options = getProviderOptions("gpt-5.5", "openai")
      expect(gpt55Options.openai?.reasoningEffort).toBe("none")

      const gpt54ProOptions = getProviderOptions("gpt-5.4-pro", "openai")
      expect(gpt54ProOptions.openai?.reasoningEffort).toBe("medium")

      const mixedCaseGpt54ProOptions = getProviderOptions("GPT-5.4-Pro", "openai")
      expect(mixedCaseGpt54ProOptions.openai?.reasoningEffort).toBe("medium")

      const gpt52ProOptions = getProviderOptions("gpt-5.2-pro", "openai")
      expect(gpt52ProOptions.openai?.reasoningEffort).toBe("medium")

      const gpt5ProOptions = getProviderOptions("gpt-5-pro", "openai")
      expect(gpt5ProOptions.openai?.reasoningEffort).toBe("high")

      const gpt54Options = getProviderOptions("gpt-5.4", "openai")
      expect(gpt54Options.openai?.reasoningEffort).toBe("none")

      const gpt54MiniOptions = getProviderOptions("gpt-5.4-mini", "openai")
      expect(gpt54MiniOptions.openai?.reasoningEffort).toBe("none")

      const gpt54NanoOptions = getProviderOptions("gpt-5.4-nano", "openai")
      expect(gpt54NanoOptions.openai?.reasoningEffort).toBe("none")

      const gpt52Options = getProviderOptions("gpt-5.2", "openai")
      expect(gpt52Options.openai?.reasoningEffort).toBe("none")

      const gpt51Options = getProviderOptions("gpt-5.1", "openai")
      expect(gpt51Options.openai?.reasoningEffort).toBe("none")

      const gpt51CodexOptions = getProviderOptions("gpt-5.1-codex", "openai")
      expect(gpt51CodexOptions.openai?.reasoningEffort).toBe("none")

      const gpt51CodexMiniOptions = getProviderOptions("gpt-5.1-codex-mini", "openai")
      expect(gpt51CodexMiniOptions.openai?.reasoningEffort).toBe("none")
    })

    it("should return minimal for legacy GPT-5 models", () => {
      const gpt5Options = getProviderOptions("gpt-5", "openai")
      expect(gpt5Options.openai?.reasoningEffort).toBe("minimal")

      const gpt5MiniOptions = getProviderOptions("gpt-5-mini", "openai")
      expect(gpt5MiniOptions.openai?.reasoningEffort).toBe("minimal")

      const gpt5NanoOptions = getProviderOptions("gpt-5-nano", "openai")
      expect(gpt5NanoOptions.openai?.reasoningEffort).toBe("minimal")

      const gpt5CodexOptions = getProviderOptions("gpt-5-codex", "openai")
      expect(gpt5CodexOptions.openai?.reasoningEffort).toBe("minimal")
    })

    it("should omit recommendations for GPT-5 chat-latest models", () => {
      expect(getProviderOptions("gpt-5-chat-latest", "openai")).toEqual({})
      expect(getProviderOptions("gpt-5.1-chat-latest", "openai")).toEqual({})
      expect(getProviderOptions("gpt-5.2-chat-latest", "openai")).toEqual({})
      expect(getProviderOptions("gpt-5.3-chat-latest", "openai")).toEqual({})
    })

    it("should return empty object for non-matching models", () => {
      const options = getProviderOptions("some-random-model", "openai")
      expect(options).toEqual({})
    })
  })

  describe("glm model pattern matching", () => {
    it("should only match models starting with GLM-", () => {
      const middle = getProviderOptions("my-glm-model", "openai-compatible")
      expect(middle.openaiCompatible).toBeUndefined()

      const end = getProviderOptions("model-GLM", "openai-compatible")
      expect(end.openaiCompatible).toBeUndefined()
    })
  })

  describe("user provider option overrides", () => {
    it("should skip reasoning-only recommendations when top-level reasoning is explicit", () => {
      const options = getProviderOptionsWithOverride("gpt-5-mini", "openai", undefined, "minimal")
      expect(options).toBeUndefined()
    })

    it("should preserve explicit user provider options when top-level reasoning is explicit", () => {
      const options = getProviderOptionsWithOverride(
        "gpt-5-mini",
        "openai",
        { reasoningEffort: "high" },
        "minimal",
      )
      expect(options).toEqual({ openai: { reasoningEffort: "high" } })
    })

    it("should normalize common OpenAI-compatible snake_case aliases", () => {
      const options = getProviderOptionsWithOverride("glm-4-flash", "openai-compatible", {
        reasoning_effort: "minimal",
        verbosity: "low",
        foo: "bar",
      })

      expect(options).toEqual({
        "openai-compatible": {
          reasoningEffort: "minimal",
          textVerbosity: "low",
          foo: "bar",
        },
      })
    })
  })

  describe("recommendation metadata", () => {
    it("should expose the matched rule index for UI suggestion state", () => {
      const gpt5Match = getRecommendedProviderOptionsMatch("gpt-5-mini")
      const gpt51Match = getRecommendedProviderOptionsMatch("gpt-5.1")

      expect(gpt5Match?.matchIndex).toBeTypeOf("number")
      expect(gpt51Match?.matchIndex).toBeTypeOf("number")
      expect(gpt5Match?.matchIndex).not.toBe(gpt51Match?.matchIndex)
    })

    it("should return undefined for models without recommendations", () => {
      expect(getRecommendedProviderOptionsMatch("plain-model")).toBeUndefined()
    })
  })
})
