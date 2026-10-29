import type { JSONValue } from "ai"
import type { AISDKReasoning, LLMProviderConfig } from "@/types/config/provider"
import { resolveModelId } from "@/utils/providers/model-id"
import { getProviderOptionsWithOverride } from "@/utils/providers/options"
import { getTopLevelReasoning } from "@/utils/providers/reasoning"

export interface LocalGenerateTextParams {
  reasoning: AISDKReasoning | undefined
  temperature: number | undefined
  providerOptions: Record<string, Record<string, JSONValue>> | undefined
}

export function buildLocalGenerateTextParams(config: LLMProviderConfig): LocalGenerateTextParams {
  const reasoning = getTopLevelReasoning(config)
  const modelName = resolveModelId(config.model)

  return {
    reasoning,
    temperature: config.temperature,
    providerOptions: getProviderOptionsWithOverride(
      modelName ?? "",
      config.provider,
      config.providerOptions,
      reasoning,
    ),
  }
}
