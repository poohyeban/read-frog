import type { SubtitleRequestPayload } from "@/types/subtitle-request"
import { isLLMProviderConfig } from "@/types/config/provider"
import { Sha256Hex } from "@/utils/hash"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { freezeData } from "@/utils/immutable"
import { LANG_CODE_TO_EN_NAME } from "@/utils/languages"
import { normalizePromptContextValue } from "@/utils/prompts/context"
import { getSubtitlesTranslatePromptFromConfig } from "@/utils/prompts/subtitles"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"

export interface SubtitleSourceIdentity {
  videoId: string
  trackId: string
  revision: number
  cueKey: string
}
export interface SubtitleTranslationPlan {
  readonly source?: Readonly<SubtitleSourceIdentity>
  readonly request: Readonly<SubtitleRequestPayload>
}

/** Cue admission/dedup identity; persistent LLM caching uses the rendered whole batch. */
export function createSubtitleTranslationPlan(
  input: Omit<SubtitleRequestPayload, "hash"> & {
    promptConfig: NonNullable<SubtitleRequestPayload["promptConfig"]>
  },
  source?: SubtitleSourceIdentity,
): SubtitleTranslationPlan {
  const data = structuredClone(input)
  data.text = prepareTranslationText(data.text)
  data.webTitle = normalizePromptContextValue(data.webTitle)
  data.webDescription = normalizePromptContextValue(data.webDescription)
  data.summary = normalizePromptContextValue(data.summary)
  const identity = [
    "subtitle-plan-v1",
    data.text,
    getProviderCacheIdentity(data.providerRef),
    data.langConfig.sourceCode,
    data.langConfig.targetCode,
  ]
  if (isLLMProviderConfig(data.providerRef.config)) {
    const prompt = getSubtitlesTranslatePromptFromConfig(
      data.promptConfig,
      LANG_CODE_TO_EN_NAME[data.langConfig.targetCode],
      data.text,
      {
        isBatch: true,
        context: {
          webTitle: data.webTitle,
          webDescription: data.webDescription,
          videoSummary: data.summary,
        },
        glossaryTerms: data.glossaryTerms ?? [],
      },
    )
    identity.push(prompt.systemPrompt, prompt.prompt)
  }
  return freezeData({
    source: source ? structuredClone(source) : undefined,
    request: { ...data, hash: Sha256Hex(...identity) },
  })
}
