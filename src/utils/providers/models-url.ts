import type {
  LLMProviderConfig,
  ProtocolCompatibleLLMProviderConfig,
} from "@/types/config/provider"
import { getProviderConnectionURL } from "./connection-url"

export type ModelListProviderConfig =
  | ProtocolCompatibleLLMProviderConfig
  | Extract<LLMProviderConfig, { provider: "deepseek" }>

export function getProviderModelsURL(providerConfig: ModelListProviderConfig): string {
  const connectionURL = getProviderConnectionURL(providerConfig)
  if (!connectionURL) throw new Error("Provider endpoint is not configured")
  const url = new URL(connectionURL)

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`

  url.hash = ""
  return url.toString()
}
