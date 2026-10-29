import type {
  APIProviderConfig,
  ProtocolCompatibleLLMProviderConfig,
} from "@/types/config/provider"

/** Return the configured endpoint used to connect to an API provider. */
export function getProviderConnectionURL(
  providerConfig: ProtocolCompatibleLLMProviderConfig,
): string
export function getProviderConnectionURL(providerConfig: APIProviderConfig): string | undefined
export function getProviderConnectionURL(providerConfig: APIProviderConfig): string | undefined {
  if (providerConfig.provider === "deepseek")
    return providerConfig.baseURL || "https://api.deepseek.com"
  return providerConfig.baseURL
}
