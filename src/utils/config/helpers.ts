import type { Config } from "@/types/config/config"
import type {
  APIProviderConfig,
  LLMProviderConfig,
  ProviderConfig,
  ProvidersConfig,
} from "@/types/config/provider"
import type { FeatureKey } from "@/utils/constants/feature-providers"
import { isAPIProviderConfig, isLLMProviderConfig } from "@/types/config/provider"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { getSelectionToolbarActions, patchSelectionToolbarAction } from "@/utils/custom-actions"
import { getProviderIdsForCapability } from "@/utils/providers/provider-registry"

export function getProviderConfigById<T extends ProviderConfig>(
  providersConfig: T[],
  providerId: string,
): T | undefined {
  return providersConfig.find((p) => p.id === providerId)
}

export function getLLMProvidersConfig(providersConfig: ProvidersConfig): LLMProviderConfig[] {
  return providersConfig.filter(isLLMProviderConfig)
}

export function getAPIProvidersConfig(providersConfig: ProvidersConfig): APIProviderConfig[] {
  return providersConfig.filter(isAPIProviderConfig)
}

export function filterEnabledProvidersConfig(providersConfig: ProvidersConfig): ProvidersConfig {
  return providersConfig.filter((p) => p.enabled)
}

/**
 * Compute fallback provider assignments when a provider is deleted.
 * For each feature using the deleted provider, picks the first remaining
 * provider that can actually run it — reassigning to one the account cannot use
 * is what turns a delete into a silently broken feature.
 */
export function computeProviderFallbacksAfterDeletion(
  deletedProviderId: string,
  config: Config,
  remainingProviders: ProvidersConfig,
): Partial<Record<FeatureKey, string>> {
  const updates: Partial<Record<FeatureKey, string>> = {}
  for (const key of FEATURE_KEYS) {
    const def = FEATURE_PROVIDER_DEFS[key]
    const currentId = def.getProviderId(config)
    if (currentId !== deletedProviderId) continue
    const fallbackProviderId = getProviderIdsForCapability(key, remainingProviders, {
      requireEnable: true,
    })[0]
    if (fallbackProviderId) updates[key] = fallbackProviderId
  }
  return updates
}

/**
 * The first feature that would be left with no provider that can actually run
 * it, or null when every feature keeps a working one.
 *
 * Gated on usable providers, not merely present ones. `getProviderIdsForCapability`
 * appends the built-ins unconditionally, so the old presence check was
 * satisfied for every feature and this guard never fired — a user could delete
 * their last BYOK provider and have half the extension silently reassigned to a
 * tier their plan does not fund.
 *
 * `status` decides which built-ins count. Omitting it (or passing a status that
 * has not loaded) treats them as usable, so an unreachable status endpoint
 * cannot block someone from deleting their own credentials.
 *
 * Features the user has switched off count too. Their `providerId` is stored
 * either way, and `computeProviderFallbacksAfterDeletion` can only reassign it
 * when a replacement exists — so letting the delete through leaves the slot
 * pointing at a provider that no longer exists at all, which resolves to null
 * the moment the feature is switched back on.
 */
export function findFeatureMissingProvider(remainingProviders: ProvidersConfig): FeatureKey | null {
  for (const key of FEATURE_KEYS) {
    if (!getProviderIdsForCapability(key, remainingProviders, { requireEnable: true })[0]) {
      return key
    }
  }

  return null
}

/**
 * Reassign selection toolbar actions that reference the deleted provider.
 * Fallback target must be the first enabled LLM provider.
 * Returns null when no action is affected or when no fallback exists.
 */
export function computeSelectionToolbarCustomActionFallbacksAfterDeletion(
  deletedProviderId: string,
  config: Config,
  remainingProviders: ProvidersConfig,
): Config["selectionToolbar"] | null {
  const affectedActions = getSelectionToolbarActions(config.selectionToolbar).filter(
    (action) => action.providerId === deletedProviderId,
  )

  if (affectedActions.length === 0) {
    return null
  }

  const fallbackProviderId = getProviderIdsForCapability("customAction", remainingProviders, {
    requireEnable: true,
  })[0]
  if (!fallbackProviderId) {
    return null
  }

  return affectedActions.reduce(
    (selectionToolbar, action) =>
      patchSelectionToolbarAction(selectionToolbar, action.id, {
        providerId: fallbackProviderId,
      }),
    config.selectionToolbar,
  )
}

/**
 * Compute languageDetection fallback when a provider is deleted.
 * Only applies when mode is "llm" and the deleted provider is the current one.
 * Returns the new providerId (first enabled LLM), or undefined if none available.
 * Returns null when no change is needed.
 */
