import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { LangCodeISO6393 } from "@/utils/languages"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { LANG_CODE_TO_EN_NAME } from "@/utils/languages"
import { getTranslatePromptFromConfig } from "@/utils/prompts/translate"
import { prepareTranslationText } from "./text-preparation"

export function normalizePromptContextValue(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined) {
    return value
  }
  return value.trim() === "" ? null : value
}

export function normalizeWebPagePromptContext(
  webPageContext?: WebPagePromptContext,
): WebPagePromptContext | undefined {
  if (!webPageContext) {
    return undefined
  }

  return {
    webTitle: normalizePromptContextValue(webPageContext.webTitle),
    webDescription: normalizePromptContextValue(webPageContext.webDescription),
    webContent: normalizePromptContextValue(webPageContext.webContent),
    webSummary: normalizePromptContextValue(webPageContext.webSummary),
  }
}

export function buildWebPageHashComponents(
  text: string,
  providerRef: SerializableProviderRef,
  partialLangConfig: { sourceCode: LangCodeISO6393 | "auto"; targetCode: LangCodeISO6393 },
  enableAIContentAware: boolean,
  textFormat: TranslationTextFormat,
  preserveLineBreaks: boolean,
  glossaryTerms: readonly MatchedTerm[],
  webPageContext: WebPagePromptContext | undefined,
  promptConfig: Pick<Config["pageTranslation"], "customPromptsConfig">,
): string[] {
  const preparedText = prepareTranslationText(text)
  const normalizedWebPageContext = normalizeWebPagePromptContext(webPageContext)

  const providerHashIdentity = providerRef.config
  const hashComponents = [
    preparedText,
    JSON.stringify(providerHashIdentity),
    partialLangConfig.sourceCode,
    partialLangConfig.targetCode,
  ]

  const targetLangName = LANG_CODE_TO_EN_NAME[partialLangConfig.targetCode]
  // The terms are passed in rather than resolved here, so the prompt this hash
  // is taken over is built from exactly the terms the request will carry.
  const promptOptions = { isBatch: true, context: normalizedWebPageContext, glossaryTerms }
  const { systemPrompt, prompt } = getTranslatePromptFromConfig(
    promptConfig,
    targetLangName,
    preparedText,
    promptOptions,
  )
  hashComponents.push(
    systemPrompt,
    prompt,
    `format:${textFormat}`,
    `lineBreaks:${preserveLineBreaks}`,
  )
  hashComponents.push(
    enableAIContentAware ? "enableAIContentAware=true" : "enableAIContentAware=false",
  )

  if (enableAIContentAware && normalizedWebPageContext) {
    if (normalizedWebPageContext.webTitle) {
      hashComponents.push(`webTitle:${normalizedWebPageContext.webTitle}`)
    }
    if (normalizedWebPageContext.webDescription) {
      hashComponents.push(`webDescription:${normalizedWebPageContext.webDescription}`)
    }
    if (normalizedWebPageContext.webContent) {
      hashComponents.push(`webContent:${normalizedWebPageContext.webContent}`)
    }
    if (normalizedWebPageContext.webSummary) {
      hashComponents.push(`webSummary:${normalizedWebPageContext.webSummary}`)
    }
  }

  return hashComponents
}
