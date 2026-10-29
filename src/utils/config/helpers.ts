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

export function clearProviderAssignments(
  deletedProviderId: string,
  config: Config,
): Partial<Record<FeatureKey, string>> {
  return Object.fromEntries(
    FEATURE_KEYS.filter(
      (key) => FEATURE_PROVIDER_DEFS[key].getProviderId(config) === deletedProviderId,
    ).map((key) => [key, ""]),
  )
}

export function clearSelectionToolbarProvider(
  deletedProviderId: string,
  config: Config,
): Config["selectionToolbar"] {
  return getSelectionToolbarActions(config.selectionToolbar)
    .filter((a) => a.providerId === deletedProviderId)
    .reduce(
      (toolbar, action) => patchSelectionToolbarAction(toolbar, action.id, { providerId: "" }),
      config.selectionToolbar,
    )
}
