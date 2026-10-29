import type { Config } from "@/types/config/config"
import type { ConfigMeta } from "@/types/config/meta"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { initI18n } from "@/utils/i18n"
import {
  buildFreshDefaultConfig,
  CONFIG_SCHEMA_VERSION,
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
} from "../constants/config"
import { logger } from "../logger"

export interface InitializeConfigResult {
  /**
   * The config was created from defaults in this run — either no stored value existed, or the
   * stored value failed validation and was rebuilt. Callers use it to run one-time setup that
   * only makes sense on untouched defaults (see `selectFreshTranslateProviders`).
   */
  isFreshInstall: boolean
}

/**
 * Initialize the config, this function should only be called once in the background script
 * @returns The extension config
 */
export async function initializeConfig(): Promise<InitializeConfigResult> {
  const [storedConfig, configMeta] = await Promise.all([
    storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`),
    storage.getMeta<ConfigMeta>(`local:${CONFIG_STORAGE_KEY}`),
  ])

  let config: Config
  let currentVersion: number
  let didConfigChange = false
  let isFreshInstall = false

  if (!storedConfig) {
    // Initialize locale before building defaults used by this browser context.
    await initI18n(DEFAULT_CONFIG.uiLanguage)
    config = buildFreshDefaultConfig()
    currentVersion = CONFIG_SCHEMA_VERSION
    didConfigChange = true
    isFreshInstall = true
  } else {
    config = storedConfig
    currentVersion = configMeta?.schemaVersion ?? 1
  }

  const parsedConfig = configSchema.safeParse(config)
  if (parsedConfig.success) {
    // Stored as every reader gets it: defaults filled in, the selection
    // toolbar's order and pins in step with its actions.
    config = parsedConfig.data
  } else {
    logger.warn("Config is invalid, using default config")
    await initI18n(DEFAULT_CONFIG.uiLanguage)
    config = buildFreshDefaultConfig()
    currentVersion = CONFIG_SCHEMA_VERSION
    didConfigChange = true
    // The rebuilt config is untouched defaults, so recovered users get the
    // same one-time provider selection a genuine fresh install does.
    isFreshInstall = true
  }

  const didMetaNeedUpdate =
    configMeta?.schemaVersion !== currentVersion || configMeta?.lastModifiedAt === undefined

  if (didConfigChange) {
    await storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, config)
  }

  if (didConfigChange || didMetaNeedUpdate) {
    await storage.setMeta<ConfigMeta>(`local:${CONFIG_STORAGE_KEY}`, {
      schemaVersion: currentVersion,
      lastModifiedAt: configMeta?.lastModifiedAt ?? Date.now(),
    })
  }

  return { isFreshInstall }
}
