import type { ResolvedProviderRef } from "./provider-registry"
import type { Config } from "@/types/config/config"
import type { LLMProviderConfig, TranslateProviderConfig } from "@/types/config/provider"
import { isLLMProviderConfig } from "@/types/config/provider"
import { resolveProviderRefForCapability } from "./provider-registry"

export type SerializableProviderRef = { kind: "local"; config: TranslateProviderConfig }
export type PromptableProviderRef = { kind: "local"; config: LLMProviderConfig }
export function resolvePageTranslationProvider(
  config: Config,
): ResolvedProviderRef<TranslateProviderConfig> {
  const resolved = resolveProviderRefForCapability(
    "pageTranslation",
    config.providersConfig,
    config.pageTranslation.providerId,
  )
  if (!resolved) {
    throw new Error(`No page translation provider for id "${config.pageTranslation.providerId}"`)
  }
  return resolved
}

export function resolvePageTranslationProviderOrNull(
  config: Config,
): ResolvedProviderRef<TranslateProviderConfig> | null {
  try {
    return resolvePageTranslationProvider(config)
  } catch {
    return null
  }
}

export function getProviderCacheIdentity(ref: SerializableProviderRef): string {
  return JSON.stringify(ref.config)
}
export function canProviderRefGenerateText(
  ref: SerializableProviderRef,
): ref is PromptableProviderRef {
  return isLLMProviderConfig(ref.config)
}
export function canResolvedProviderRefGenerateText(
  ref: ResolvedProviderRef,
): ref is ResolvedProviderRef<LLMProviderConfig> {
  return isLLMProviderConfig(ref.config)
}
export async function serializeProviderRef<T extends TranslateProviderConfig>(
  provider: ResolvedProviderRef<T>,
  _route?: string,
): Promise<{ kind: "local"; config: T }> {
  return { kind: "local", config: provider.config }
}
export async function checkProviderAvailability<T extends TranslateProviderConfig>(
  provider: ResolvedProviderRef<T>,
  route?: string,
) {
  return { available: true as const, providerRef: await serializeProviderRef(provider, route) }
}
