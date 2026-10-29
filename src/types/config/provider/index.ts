import type {
  APIProviderConfig,
  DedicatedLLMProviderConfig,
  LLMProviderConfig,
  OpenAICompatibleLLMProviderConfig,
  ProtocolCompatibleLLMProviderConfig,
  ProviderConfig,
  TopLevelReasoningProviderConfig,
  TranslateProviderConfig,
} from "./schemas"
import {
  isAPIProvider,
  isDedicatedLLMProvider,
  isLLMProvider,
  isOpenAICompatibleLLMProvider,
  isProtocolCompatibleLLMProvider,
  isTranslateProvider,
  supportsTopLevelReasoning,
} from "./constants"

export * from "./constants"

export * from "./schemas"

export function isTranslateProviderConfig(
  config: ProviderConfig,
): config is TranslateProviderConfig {
  return isTranslateProvider(config.provider)
}

export function isLLMProviderConfig(config: ProviderConfig): config is LLMProviderConfig {
  return isLLMProvider(config.provider)
}

export function isTopLevelReasoningProviderConfig(
  config: LLMProviderConfig,
): config is TopLevelReasoningProviderConfig {
  return supportsTopLevelReasoning(config.provider)
}

export function isOpenAICompatibleLLMProviderConfig(
  config: ProviderConfig,
): config is OpenAICompatibleLLMProviderConfig {
  return isOpenAICompatibleLLMProvider(config.provider)
}

export function isProtocolCompatibleLLMProviderConfig(
  config: ProviderConfig,
): config is ProtocolCompatibleLLMProviderConfig {
  return isProtocolCompatibleLLMProvider(config.provider)
}

export function isDedicatedLLMProviderConfig(
  config: ProviderConfig,
): config is DedicatedLLMProviderConfig {
  return isDedicatedLLMProvider(config.provider)
}

export function isAPIProviderConfig(config: ProviderConfig): config is APIProviderConfig {
  return isAPIProvider(config.provider)
}

export function isAudioProviderConfig(
  config: ProviderConfig,
): config is Extract<ProviderConfig, { provider: "openai" | "openai-compatible" }> {
  return config.provider === "openai" || config.provider === "openai-compatible"
}
