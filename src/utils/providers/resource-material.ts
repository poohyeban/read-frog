import type { LLMProviderConfig } from "@/types/config/provider"
import type { IdentityMaterial } from "@/utils/request/resource-identity"
import { getProviderHeaders } from "./headers"

const endpoints = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://127.0.0.1:11434",
  "openai-compatible": "",
} as const

/** Match the adapter's effective headers, including explicit authentication overrides. */
export function providerIdentityMaterial(config: LLMProviderConfig): IdentityMaterial {
  const headers = new Headers(
    config.provider === "google"
      ? { "x-goog-api-key": config.apiKey ?? "" }
      : config.apiKey
        ? { authorization: `Bearer ${config.apiKey}` }
        : {},
  )
  for (const [key, value] of Object.entries(getProviderHeaders(config.headers) ?? {}))
    headers.set(key, value)
  // Unknown custom headers may select a tenant or authenticate a gateway. Keep
  // them isolated rather than guessing that two credentials are interchangeable.
  const authentication = Object.fromEntries(
    [...headers].filter(([key]) => !["user-agent", "content-type", "accept"].includes(key)),
  )
  return {
    endpoint: config.baseURL || endpoints[config.provider],
    authentication,
    organization: headers.get("openai-organization") ?? undefined,
    project: headers.get("openai-project") ?? undefined,
  }
}

/** A cheap config-event fingerprint, never exported/logged/persisted. No cryptography on requests. */
export function providerTransportRevision(config: LLMProviderConfig) {
  return JSON.stringify([
    config.provider,
    config.baseURL,
    config.apiKey,
    getProviderHeaders(config.headers),
  ])
}
