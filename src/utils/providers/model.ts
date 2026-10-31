import type { Config } from "@/types/config/config"
import type { DedicatedLLMProviderTypes, LLMProviderConfig } from "@/types/config/provider"
import type { ExecutionPermit } from "@/utils/request/resource-scheduler"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOllama } from "ai-sdk-ollama"
import { match } from "ts-pattern"
import { storage } from "#imports"
import {
  isDedicatedLLMProviderConfig,
  isOpenAICompatibleLLMProviderConfig,
} from "@/types/config/provider"
import { ResourceRejected } from "@/utils/request/resource-error"
import { getLLMProvidersConfig, getProviderConfigById } from "../config/helpers"
import { CONFIG_STORAGE_KEY } from "../constants/config"
import { getProviderHeaders } from "./headers"
import { resolveModelId } from "./model-id"
import { ProviderSetupError } from "./provider-setup-error"

const DEDICATED_PROVIDER_FACTORY_BY_TYPE = {
  deepseek: createDeepSeek,
  openai: createOpenAI,

  google: createGoogleGenerativeAI,

  ollama: createOllama,
} as const satisfies Record<DedicatedLLMProviderTypes, unknown>

// Custom API credentials must stay on the configured endpoint, including when
// a server responds with a redirect. Extension requests do not need cookies.
function providerFetch(permit?: ExecutionPermit): typeof fetch {
  return (input, init) => {
    if (!permit) throw new ResourceRejected("identity")
    permit.start()
    return fetch(input, { ...init, credentials: "omit", redirect: "error" })
  }
}

async function getLanguageModelById(providerId: string) {
  const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
  if (!config) {
    throw new ProviderSetupError("Config not found")
  }

  const LLMProvidersConfig = getLLMProvidersConfig(config.providersConfig)
  const providerConfig = getProviderConfigById(LLMProvidersConfig, providerId)
  if (!providerConfig) {
    throw new ProviderSetupError(`Provider ${providerId} not found`)
  }

  return getLanguageModelForConfig(providerConfig)
}

/**
 * Build a model from a config the caller already holds.
 *
 * Callers that were handed a provider config — a transported `providerRef`, say
 * — must use this rather than looking the id up again: re-reading storage picks
 * up edits made after the ref was captured, so the model would come from the
 * new row while the params derived from the ref came from the old one.
 */
export function getLanguageModelForConfig(
  providerConfig: LLMProviderConfig,
  permit?: ExecutionPermit,
) {
  const headers = getProviderHeaders(providerConfig.headers)

  const provider = match(providerConfig)
    .when(isOpenAICompatibleLLMProviderConfig, (matchedConfig) =>
      createOpenAICompatible({
        fetch: providerFetch(permit),
        name: matchedConfig.provider,
        baseURL: matchedConfig.baseURL,
        supportsStructuredOutputs: true,
        ...(matchedConfig.apiKey && { apiKey: matchedConfig.apiKey }),
        ...(headers && { headers }),
      }),
    )
    .when(isDedicatedLLMProviderConfig, (matchedConfig) =>
      DEDICATED_PROVIDER_FACTORY_BY_TYPE[matchedConfig.provider]({
        fetch: providerFetch(permit),
        ...(matchedConfig.baseURL && { baseURL: matchedConfig.baseURL }),
        ...(matchedConfig.apiKey && { apiKey: matchedConfig.apiKey }),
        ...(headers && { headers }),
      }),
    )
    .exhaustive()

  const modelId = resolveModelId(providerConfig.model)

  if (!modelId) {
    throw new ProviderSetupError("Model is undefined")
  }

  if (providerConfig.provider === "ollama") {
    return (provider as ReturnType<typeof createOllama>).languageModel(modelId, { think: false })
  }

  return provider.languageModel(modelId)
}

export async function getModelById(providerId: string) {
  return getLanguageModelById(providerId)
}
