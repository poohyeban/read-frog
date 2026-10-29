import type {
  AllProviderTypes,
  APIProviderTypes,
  CustomModelOnlyProviderTypes,
  LLMProviderModels,
  ProviderConfig,
  ProvidersConfig,
} from "@/types/config/provider"
import type { Theme } from "@/types/config/theme"
import { camelCase } from "case-anything"
import customProviderLogo from "@/assets/providers/custom-provider.svg?url&no-inline"
import {
  API_PROVIDER_TYPES,
  DEDICATED_LLM_PROVIDER_TYPES,
  PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES,
  TRANSLATE_PROVIDER_TYPES,
  isAPIProviderConfig,
  isCustomModelOnlyProvider,
} from "@/types/config/provider"
import { pick } from "@/types/utils"
import { i18n } from "@/utils/i18n"

export const DEFAULT_LLM_PROVIDER_MODELS: LLMProviderModels = {
  "openai-compatible": {
    model: "use-custom-model",
    isCustomModel: true,
    customModel: null,
  },

  openai: {
    model: "gpt-6-luna",
    isCustomModel: false,
    customModel: null,
  },

  google: {
    model: "gemini-3.5-flash-lite",
    isCustomModel: false,
    customModel: null,
  },

  ollama: {
    model: "gemma3:4b",
    isCustomModel: false,
    customModel: null,
  },
}

export const PROVIDER_ITEMS: Record<
  AllProviderTypes,
  {
    logo: (theme: Theme) => string
    name: string
    website: string

    /**
     * Where someone signs up for or copies this provider's key. Only providers that set it get
     * the "Get API key" button next to the API key field — absent means no button, because most
     * providers' key pages sit behind a console we cannot link straight into.
     */
    apiKeyUrl?: string
  }
> = {
  "openai-compatible": {
    logo: () => customProviderLogo,
    name: "Custom Chat Complete",
    website: "https://platform.openai.com/docs",
  },

  openai: {
    logo: () => customProviderLogo,
    name: "OpenAI",
    website: "https://platform.openai.com",
  },

  google: {
    logo: () => customProviderLogo,
    name: "Gemini",
    website: "https://aistudio.google.com",
  },

  ollama: {
    logo: () => customProviderLogo,
    name: "Ollama",
    website: "https://ollama.ai",
  },
}

export const DEFAULT_PROVIDER_CONFIG = {
  "openai-compatible": {
    id: "openai-compatible-default",
    name: PROVIDER_ITEMS["openai-compatible"].name,
    enabled: true,
    provider: "openai-compatible",
    baseURL: "https://api.example.com/v1",
    model: DEFAULT_LLM_PROVIDER_MODELS["openai-compatible"],
  },

  openai: {
    id: "openai-default",
    name: PROVIDER_ITEMS.openai.name,
    enabled: true,
    provider: "openai",
    model: DEFAULT_LLM_PROVIDER_MODELS.openai,
    reasoning: "none",
  },

  google: {
    id: "google-default",
    name: PROVIDER_ITEMS.google.name,
    enabled: true,
    provider: "google",
    model: DEFAULT_LLM_PROVIDER_MODELS.google,
    reasoning: "none",
  },

  ollama: {
    id: "ollama-default",
    name: PROVIDER_ITEMS.ollama.name,
    enabled: true,
    provider: "ollama",
    model: DEFAULT_LLM_PROVIDER_MODELS.ollama,
  },
} as const satisfies Record<AllProviderTypes, ProviderConfig>

export const DEFAULT_TRANSLATE_PROVIDER_ID = DEFAULT_PROVIDER_CONFIG.openai.id

/**
 * Headers a provider is always called with, merged over whatever the user set. The user may add
 * headers alongside these but cannot drop or rewrite them, and they never enter stored config —
 * which is also what makes them ours to change in a later release. A header a provider merely
 * starts out with belongs in `DEFAULT_PROVIDER_CONFIG[provider].headers` instead, where the user
 * owns it.
 */

export const PROVIDER_URL_PLACEHOLDERS: Partial<Record<APIProviderTypes, string>> = {
  "openai-compatible": DEFAULT_PROVIDER_CONFIG["openai-compatible"].baseURL,

  openai: "https://api.openai.com/v1",

  google: "https://generativelanguage.googleapis.com/v1beta",

  ollama: "http://127.0.0.1:11434/",
}

export const DEFAULT_PROVIDER_CONFIG_LIST: ProvidersConfig = [
  DEFAULT_PROVIDER_CONFIG.openai,
  DEFAULT_PROVIDER_CONFIG.google,
  DEFAULT_PROVIDER_CONFIG["openai-compatible"],
  DEFAULT_PROVIDER_CONFIG.ollama,
]

/** Resolve a provider's default description in the active interface language. */
export function getDefaultProviderDescription(providerType: APIProviderTypes): string | undefined {
  const descriptionKey = camelCase(providerType)
  const description = i18n.t(
    `options.apiProviders.providers.description.${descriptionKey}` as never,
  )
  return description || undefined
}

/**
 * Build providers for a fresh config after i18n has initialized, so descriptions are
 * persisted in the same interface language as providers created from the options page.
 */
export function buildDefaultProviderConfigList(): ProvidersConfig {
  return structuredClone(DEFAULT_PROVIDER_CONFIG_LIST).map((providerConfig) => {
    if (!isAPIProviderConfig(providerConfig)) {
      return providerConfig
    }

    const description = getDefaultProviderDescription(providerConfig.provider)
    return description ? { ...providerConfig, description } : providerConfig
  })
}

export const TRANSLATE_PROVIDER_ITEMS = pick(PROVIDER_ITEMS, TRANSLATE_PROVIDER_TYPES)

export const LLM_PROVIDER_ITEMS = TRANSLATE_PROVIDER_ITEMS

export const API_PROVIDER_ITEMS = pick(PROVIDER_ITEMS, API_PROVIDER_TYPES)

const PROVIDER_NAME_I18N_KEYS = {
  "openai-compatible": "options.apiProviders.providers.name.customChatComplete",
} as const satisfies Record<CustomModelOnlyProviderTypes, string>

export function getProviderItemName(providerType: APIProviderTypes): string {
  if (!isCustomModelOnlyProvider(providerType)) {
    return PROVIDER_ITEMS[providerType].name
  }

  return i18n.t(PROVIDER_NAME_I18N_KEYS[providerType]) || PROVIDER_ITEMS[providerType].name
}

export const PROVIDER_GROUPS = {
  builtInProviders: {
    types: DEDICATED_LLM_PROVIDER_TYPES,
    tutorialSlug: "built-in-providers",
  },
  compatibleProviders: {
    types: PROTOCOL_COMPATIBLE_LLM_PROVIDER_TYPES,
    tutorialSlug: "openai-compatible-providers",
  },
} as const satisfies Record<string, { types: readonly APIProviderTypes[]; tutorialSlug: string }>
