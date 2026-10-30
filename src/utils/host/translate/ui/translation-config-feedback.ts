import type { Config } from "@/types/config/config"
import { toastManager } from "@/components/ui/base-ui/toast"
import { isAPIProviderConfig } from "@/types/config/provider"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"

export function validateTranslationConfigAndToast(
  config: Pick<Config, "providersConfig" | "pageTranslation" | "language">,
): boolean {
  const { providersConfig, pageTranslation: translateConfig, language: languageConfig } = config
  const provider = resolveProviderRefForCapability(
    "pageTranslation",
    providersConfig,
    translateConfig.providerId,
  )
  if (!provider) {
    return false
  }

  if (languageConfig.sourceCode === languageConfig.targetCode) {
    toastManager.add({ type: "error", title: i18n.t("translation.sameLanguage") })
    logger.info("validateTranslationConfig: returning false (same language)")
    return false
  }

  // check if the API key is configured
  if (
    provider.kind === "local" &&
    isAPIProviderConfig(provider.config) &&
    !provider.config.apiKey?.trim() &&
    !["deeplx", "ollama"].includes(provider.config.provider)
  ) {
    toastManager.add({ type: "error", title: i18n.t("noAPIKeyConfig.warning") })
    logger.info("validateTranslationConfig: returning false (no API key)")
    return false
  }

  return true
}
