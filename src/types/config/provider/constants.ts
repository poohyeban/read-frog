import {
  LLM_PROVIDER_MODELS,
  NON_API_TRANSLATE_PROVIDERS,
  NON_API_TRANSLATE_PROVIDERS_MAP,
  PURE_TRANSLATE_PROVIDERS,
} from "@/utils/constants/models"

// Re-export for external consumers.
export {
  LLM_PROVIDER_MODELS,
  NON_API_TRANSLATE_PROVIDERS,
  NON_API_TRANSLATE_PROVIDERS_MAP,
  PURE_TRANSLATE_PROVIDERS,
}

/* ──────────────────────────────
  Derived provider names
  ────────────────────────────── */

// translate provider names
export const TRANSLATE_PROVIDER_TYPES = [
  "google-translate",

  "openai",

  "google",

  "openai-compatible",

  "ollama",
] as const satisfies Readonly<
  (keyof typeof LLM_PROVIDER_MODELS | (typeof PURE_TRANSLATE_PROVIDERS)[number])[]
>
export type TranslateProviderTypes = (typeof TRANSLATE_PROVIDER_TYPES)[number]
export function isTranslateProvider(provider: string): provider is TranslateProviderTypes {
  return TRANSLATE_PROVIDER_TYPES.includes(provider)
}

export const LLM_PROVIDER_TYPES = [
  "openai",

  "google",

  "openai-compatible",

  "ollama",
] as const satisfies Readonly<(keyof typeof LLM_PROVIDER_MODELS)[]>
export type LLMProviderTypes = (typeof LLM_PROVIDER_TYPES)[number]
export function isLLMProvider(provider: string): provider is LLMProviderTypes {
  return LLM_PROVIDER_TYPES.includes(provider)
}

const OPENAI_COMPATIBLE_CUSTOM_LLM_PROVIDER_TYPE = "openai-compatible"

export const OPENAI_COMPATIBLE_LLM_PROVIDER_TYPES = [
  OPENAI_COMPATIBLE_CUSTOM_LLM_PROVIDER_TYPE,
] as const satisfies Readonly<LLMProviderTypes[]>
export type OpenAICompatibleLLMProviderTypes = (typeof OPENAI_COMPATIBLE_LLM_PROVIDER_TYPES)[number]
export function isOpenAICompatibleLLMProvider(
  provider: string,
): provider is OpenAICompatibleLLMProviderTypes {
  return OPENAI_COMPATIBLE_LLM_PROVIDER_TYPES.includes(provider)
}

export const PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES = [
  OPENAI_COMPATIBLE_CUSTOM_LLM_PROVIDER_TYPE,
] as const satisfies Readonly<OpenAICompatibleLLMProviderTypes[]>
export type ProtocolCompatibleLLMProviderTypes =
  (typeof PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES)[number]
export function isProtocolCompatibleLLMProvider(
  provider: string,
): provider is ProtocolCompatibleLLMProviderTypes {
  return PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES.includes(provider)
}

export const CUSTOM_MODEL_ONLY_PROVIDER_TYPES = [
  OPENAI_COMPATIBLE_CUSTOM_LLM_PROVIDER_TYPE,
] as const satisfies Readonly<ProtocolCompatibleLLMProviderTypes[]>
export type CustomModelOnlyProviderTypes = (typeof CUSTOM_MODEL_ONLY_PROVIDER_TYPES)[number]
export function isCustomModelOnlyProvider(
  provider: string,
): provider is CustomModelOnlyProviderTypes {
  return CUSTOM_MODEL_ONLY_PROVIDER_TYPES.includes(provider)
}

export const DEDICATED_LLM_PROVIDER_TYPES = [
  "openai",

  "google",

  "ollama",
] as const satisfies Readonly<Exclude<LLMProviderTypes, ProtocolCompatibleLLMProviderTypes>[]>
export type DedicatedLLMProviderTypes = (typeof DEDICATED_LLM_PROVIDER_TYPES)[number]
export function isDedicatedLLMProvider(provider: string): provider is DedicatedLLMProviderTypes {
  return DEDICATED_LLM_PROVIDER_TYPES.includes(provider)
}

export const API_PROVIDER_TYPES = [
  "openai-compatible",

  "openai",

  "google",

  "ollama",
] as const satisfies Readonly<(keyof typeof LLM_PROVIDER_MODELS | "deeplx" | "deepl")[]>
export type APIProviderTypes = (typeof API_PROVIDER_TYPES)[number]
export function isAPIProvider(provider: string): provider is APIProviderTypes {
  return API_PROVIDER_TYPES.includes(provider)
}

export type NonAPIProviderTypes = (typeof NON_API_TRANSLATE_PROVIDERS)[number]
export function isNonAPIProvider(provider: string): provider is NonAPIProviderTypes {
  return NON_API_TRANSLATE_PROVIDERS.includes(provider)
}

// all provider names
export const ALL_PROVIDER_TYPES = [
  "google-translate",

  "openai-compatible",

  "openai",

  "google",

  "ollama",
] as const satisfies Readonly<TranslateProviderTypes[]>
export type AllProviderTypes = (typeof ALL_PROVIDER_TYPES)[number]

export const AI_SDK_REASONING_VALUES = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const
export type AISDKReasoning = (typeof AI_SDK_REASONING_VALUES)[number]

export const TOP_LEVEL_REASONING_PROVIDER_TYPES = [
  "openai",

  "google",
] as const satisfies Readonly<LLMProviderTypes[]>
export type TopLevelReasoningProviderTypes = (typeof TOP_LEVEL_REASONING_PROVIDER_TYPES)[number]
export function supportsTopLevelReasoning(
  provider: string,
): provider is TopLevelReasoningProviderTypes {
  return TOP_LEVEL_REASONING_PROVIDER_TYPES.includes(provider)
}

export function isPureTranslateProvider(
  provider: TranslateProviderTypes,
): provider is (typeof PURE_TRANSLATE_PROVIDERS)[number] {
  return PURE_TRANSLATE_PROVIDERS.includes(provider)
}
