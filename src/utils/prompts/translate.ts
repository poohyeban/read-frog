import type { TranslatePromptOptions, TranslatePromptResult } from "./translation-template"
import type { WebPagePromptContext } from "@/types/content"
import { getLocalConfig } from "@/utils/config/storage"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { DEFAULT_CONFIG } from "../constants/config"
import { getTranslatePromptFromConfig } from "./translation-template"
export * from "./translation-template"

export async function getTranslatePrompt(
  targetLang: string,
  input: string,
  options?: TranslatePromptOptions<WebPagePromptContext>,
): Promise<TranslatePromptResult> {
  const config = (await getLocalConfig()) ?? DEFAULT_CONFIG
  // Resolved here rather than at each call site so both prompt builds agree: the
  // content script builds one to derive the cache key
  // (host/translate/translate-text.ts:142) and the background builds another for
  // the actual request. Matching is a pure function of (text, entries), so the
  // two agree as long as they see the same glossary revision. A caller that
  // already matched — the batch pipeline, which unions terms across a batch —
  // passes its own and skips this.
  const glossaryTerms =
    options?.glossaryTerms ??
    (await resolveGlossaryTerms(input, config.glossary.enabled, config.language.targetCode)).terms
  return getTranslatePromptFromConfig(config.pageTranslation, targetLang, input, {
    ...options,
    glossaryTerms,
  })
}
