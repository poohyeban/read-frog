import type { BackgroundGenerateTextPayload } from "@/types/background-generate-text"
import type { ProviderRequestRouting } from "@/types/provider-request"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { getArticleSummaryPrompt } from "@/utils/prompts/summary"
import { MAX_TEXT_LENGTH } from "./utils"
import { cleanText } from "./utils"

/** The article title is untrusted page text; bound it like the body. */
const MAX_TITLE_LENGTH = 200

// Includes the prompt, Defuddle/Markdown preparation and output validation rules.
export const ARTICLE_SUMMARY_RULE_VERSION = "article-context-v2"
export const ARTICLE_SUMMARY_MAX_OUTPUT_TOKENS = 2048
export const ARTICLE_SUMMARY_MAX_CHARACTERS = 6000

export function isValidArticleSummary(value: string): boolean {
  return value.trim().length > 0 && value.length <= ARTICLE_SUMMARY_MAX_CHARACTERS
}

export async function generateArticleSummary(
  title: string,
  textContent: string,
  routing: ProviderRequestRouting<PromptableProviderRef>,
  options: {
    signal?: AbortSignal
    generate: (
      payload: BackgroundGenerateTextPayload,
      runOptions: { signal?: AbortSignal },
    ) => Promise<string>
  },
): Promise<string | null> {
  options.signal?.throwIfAborted()
  const preparedText = cleanText(textContent, MAX_TEXT_LENGTH)

  if (!preparedText) {
    return null
  }

  const { systemPrompt, prompt } = getArticleSummaryPrompt(
    cleanText(title, MAX_TITLE_LENGTH),
    preparedText,
  )

  const payload: BackgroundGenerateTextPayload = {
    providerRef: routing.providerRef,
    instructions: systemPrompt,
    prompt,
    maxRetries: 0,
    maxOutputTokens: ARTICLE_SUMMARY_MAX_OUTPUT_TOKENS,
  }
  const summary = await options.generate(payload, { signal: options.signal })
  options.signal?.throwIfAborted()

  const cleanedSummary = summary.trim()

  if (!isValidArticleSummary(cleanedSummary)) {
    throw new Error("Invalid article summary output: empty or oversized")
  }
  return cleanedSummary
}
