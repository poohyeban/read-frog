import type { ProviderRequestRouting } from "./provider-request"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"

export type BackgroundGenerateTextPayload = ProviderRequestRouting<PromptableProviderRef> & {
  instructions: string
  prompt: string

  maxRetries?: number
  maxOutputTokens?: number
}

export interface BackgroundGenerateTextResponse {
  text: string
}
