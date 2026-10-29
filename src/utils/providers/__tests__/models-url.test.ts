import type { ProtocolCompatibleLLMProviderConfig } from "@/types/config/provider"
import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getProviderModelsURL } from "../models-url"

const model = {
  model: "use-custom-model",
  isCustomModel: true,
  customModel: "test-model",
} as const

const openAICompatibleConfig = {
  id: "openai-compatible-test",
  name: "Custom Chat Complete",
  enabled: true,
  provider: "openai-compatible",
  baseURL: "https://example.com/v1/",
  model,
} satisfies ProtocolCompatibleLLMProviderConfig

describe("getProviderModelsURL", () => {
  it("uses the same DeepSeek endpoint as the SDK, including a custom API root", () => {
    expect(getProviderModelsURL({ ...DEFAULT_PROVIDER_CONFIG.deepseek, baseURL: undefined })).toBe(
      "https://api.deepseek.com/models",
    )
    expect(
      getProviderModelsURL({
        ...DEFAULT_PROVIDER_CONFIG.deepseek,
        baseURL: "https://user-api.example/v1/",
      }),
    ).toBe("https://user-api.example/v1/models")
  })
  it("appends models to an OpenAI-compatible API root", () => {
    expect(getProviderModelsURL(openAICompatibleConfig)).toBe("https://example.com/v1/models")
  })

  it("preserves OpenAI-compatible query parameters while removing fragments", () => {
    expect(
      getProviderModelsURL({
        ...openAICompatibleConfig,
        baseURL: "https://example.com/v1/?api-version=2026-01-01#ignored",
      }),
    ).toBe("https://example.com/v1/models?api-version=2026-01-01")
  })
})
