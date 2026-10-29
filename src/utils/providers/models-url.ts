import type { ProtocolCompatibleLLMProviderConfig } from "@/types/config/provider"
import { getProviderConnectionURL } from "./connection-url"

export function getProviderModelsURL(providerConfig: ProtocolCompatibleLLMProviderConfig): string {
  const url = new URL(getProviderConnectionURL(providerConfig))

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`

  url.hash = ""
  return url.toString()
}
