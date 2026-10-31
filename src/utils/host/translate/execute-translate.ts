import type { PromptResolver } from "./api/ai"
import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { SubtitleModelGuard } from "@/utils/subtitles/work-policy"
import { isLLMProviderConfig } from "@/types/config/provider"
import { LANG_CODE_TO_EN_NAME } from "@/utils/languages"
import { aiTranslate } from "./api/ai"
import { prepareTranslationText } from "./text-preparation"

export async function executeTranslate<TContext>(
  text: string,
  langConfig: Config["language"],
  providerConfig: ProviderConfig,
  promptResolver: PromptResolver<TContext>,
  options?: {
    isBatch?: boolean
    context?: TContext
    textFormat?: TranslationTextFormat
    // Only Google needs protection: its translateHtml transport collapses
    // "\n" as HTML whitespace. Microsoft preserves newlines in both textTypes
    // (live-verified); LLM prompts already mandate format preservation.
    preserveLineBreaks?: boolean
    glossaryTerms?: readonly MatchedTerm[]
    signal?: AbortSignal
    modelGuard?: SubtitleModelGuard
    maxOutputTokens?: number
  },
) {
  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  const { provider } = providerConfig
  let translatedText: string

  if (isLLMProviderConfig(providerConfig)) {
    const targetLangName = LANG_CODE_TO_EN_NAME[langConfig.targetCode]
    translatedText = await aiTranslate(
      preparedText,
      targetLangName,
      providerConfig,
      promptResolver,
      options,
    )
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }

  return translatedText.trim()
}
