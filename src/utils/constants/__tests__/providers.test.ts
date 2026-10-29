import { describe, expect, it } from "vitest"
import {
  API_PROVIDER_TYPES,
  PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES,
  apiProviderConfigItemSchema,
  providersConfigSchema,
} from "@/types/config/provider"
import { DEFAULT_PROVIDER_CONFIG, PROVIDER_GROUPS } from "../providers"

describe("provider constants", () => {
  it("keeps every default provider compatible with its model schema", () => {
    for (const provider of API_PROVIDER_TYPES) {
      expect(apiProviderConfigItemSchema.parse(DEFAULT_PROVIDER_CONFIG[provider])).toEqual(
        DEFAULT_PROVIDER_CONFIG[provider],
      )
    }
  })

  it("defines Ollama without injecting the root URL into the default config", () => {
    expect(DEFAULT_PROVIDER_CONFIG.ollama).toEqual(
      expect.objectContaining({
        provider: "ollama",
        model: {
          model: "gemma3:4b",
          isCustomModel: false,
          customModel: null,
        },
      }),
    )
    expect(DEFAULT_PROVIDER_CONFIG.ollama).not.toHaveProperty("baseURL")
    expect(apiProviderConfigItemSchema.parse(DEFAULT_PROVIDER_CONFIG.ollama)).toEqual(
      DEFAULT_PROVIDER_CONFIG.ollama,
    )
  })

  it("keeps existing OpenAI-compatible ids and saved names unchanged", () => {
    const existingConfig = {
      ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
      id: "openai-compatible-default",
      name: "Custom Provider",
    }

    expect(providersConfigSchema.parse([existingConfig])).toEqual([existingConfig])
  })

  it("groups both protocol adapters under the compatible providers key", () => {
    expect(PROVIDER_GROUPS.compatibleProviders.types).toEqual(
      PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES,
    )
    expect(PROVIDER_GROUPS).not.toHaveProperty("openaiCompatibleProviders")
  })
})
