import type { TranslateProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { LangCodeISO6393, LangLevel } from "@/utils/languages"
import type { TranslatePromptResult } from "@/utils/prompts/translate"
import type { ResolvedProviderRef } from "@/utils/providers/provider-registry"
import { isLLMProviderConfig } from "@/types/config/provider"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { detectLanguage } from "@/utils/content/language"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { normalizePromptContextValue } from "@/utils/prompts/context"
import { getTranslationRequestHash } from "@/utils/prompts/request-identity"
import { selectPagePrompt } from "@/utils/prompts/translate"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { sendMessage } from "../../message"
import { getInMemoryTranslation, storeInMemoryTranslation } from "./in-memory-translation-cache"
import { prepareTranslationText } from "./text-preparation"
import { getPageTranslationSessionId } from "./translation-session"

/**
 * Minimum text length before a skip decision is attempted at all. Deliberately
 * below the general threshold, to catch short phrases like "Bonjour!" or
 * "こんにちは".
 *
 * Left at 10 even though detection is now franc-only. Raising it looks right
 * for Latin script — franc on ten characters is close to a coin flip there —
 * but this counts characters, and ten characters of Han, kana or Hangul is
 * plenty for franc precisely because the script alone is near-decisive. A flat
 * character count cannot express that difference, so tuning it needs a
 * script-aware rule rather than a bigger number.
 */
export const MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION = 10

export async function shouldSkipByLanguage(
  text: string,
  skipLanguages: LangCodeISO6393[],
): Promise<boolean> {
  const detectedLang = await detectLanguage(text, {
    minLength: MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
  })

  if (!detectedLang) {
    return false
  }

  return skipLanguages.includes(detectedLang)
}

export { normalizePromptContextValue } from "@/utils/prompts/context"

function normalizeWebPagePromptContext(
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

export interface TranslateTextOptions {
  promptTemplate?: TranslatePromptResult
  text: string
  langConfig: {
    sourceCode: LangCodeISO6393 | "auto"
    targetCode: LangCodeISO6393
    level: LangLevel
  }
  providerConfig: ResolvedProviderRef<TranslateProviderConfig>
  enableAIContentAware?: boolean
  extraHashTags?: string[]
  webPageContext?: WebPagePromptContext
  textFormat?: TranslationTextFormat
  // Source line breaks are semantic — see the enqueueTranslateRequest field.
  preserveLineBreaks?: boolean
  // Page-translation session id used for cancellation scoping. Deliberately
  // NOT part of the cache hash — cache identity must not vary per session.
  sessionId?: string
  forceRetranslation?: boolean
  /**
   * Whether the user's glossary is switched on. Supplied by the caller, which
   * already holds the config, rather than re-read here per paragraph — the same
   * arrangement as `enableAIContentAware`.
   */
  glossaryEnabled?: boolean
}

/**
 * Core translation function — pure, zero config fetching.
 * All dependencies must be provided explicitly.
 */
export async function translateTextCore(options: TranslateTextOptions): Promise<string> {
  const {
    text,
    langConfig,
    providerConfig,
    enableAIContentAware = false,
    extraHashTags = [],
    webPageContext,
    textFormat = "plain",
    preserveLineBreaks = false,
    sessionId,
    forceRetranslation = false,
    glossaryEnabled = false,
    promptTemplate = selectPagePrompt(DEFAULT_CONFIG.pageTranslation),
  } = options

  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  // Early cancellation gate: a session stopped while this paragraph was still

  // throw at the final gate.
  if (sessionId !== undefined && getPageTranslationSessionId() !== sessionId) {
    throw new TranslationCancelledError(sessionId)
  }

  const normalizedWebPageContext = normalizeWebPagePromptContext(webPageContext)
  const providerRef = serializeProviderRef(providerConfig)

  // Resolved ONCE, here, where `location.href` says which glossaries apply.
  // The same list feeds the cache hash and travels with the request, so the
  // prompt the hash describes is the prompt the background builds — it serves
  // every tab at once and could not scope this by itself.
  //
  // The revision travels with it because a batch can hold paragraphs resolved
  // either side of an edit made while this page was still translating, and it
  // is the only thing that tells the background which wording is the newer one
  // (see `mergeBatchGlossaryTerms`).
  const { terms: glossaryTerms, revision: glossaryRevision } = await resolveGlossaryTerms(
    preparedText,
    glossaryEnabled,
    langConfig.targetCode,
  )
  // Covers page, input and pure-translate-provider selection runs, which all
  // enter here; the two prompt-building selection paths and subtitles resolve
  // their own terms and report at their own resolve sites.

  const request = {
    text: preparedText,
    langConfig,
    providerRef,
    snapshot: {
      version: 2 as const,
      kind: "page" as const,
      template: isLLMProviderConfig(providerRef.config)
        ? { ...promptTemplate }
        : { systemPrompt: "", prompt: "" },
      glossaryEnabled,
      contentAware: enableAIContentAware,
      cacheTags: extraHashTags,
    },
    textFormat,
    preserveLineBreaks,
    webTitle: normalizedWebPageContext?.webTitle,
    webDescription: normalizedWebPageContext?.webDescription,
    webContent: normalizedWebPageContext?.webContent,
    webSummary: normalizedWebPageContext?.webSummary,
    glossaryTerms,
    glossaryRevision,
  }

  // Final gate before dispatch: if the page-translation session that owned
  // this request has ended (or been replaced) while we were preparing it,
  // abort instead of enqueueing. Sending now would either be unscoped (if the
  // id had gone null) or re-populate the queue AFTER the session's cancel
  // message already drained it — both defeat cancellation (#1881). Callers on
  // the page path swallow this error; input/selection requests carry no
  // sessionId and skip the gate entirely. The gate must also precede the
  // memory-tier read below: a cancelled session must not keep painting
  // translations out of memory.
  if (sessionId !== undefined && getPageTranslationSessionId() !== sessionId) {
    throw new TranslationCancelledError(sessionId)
  }

  const hash = getTranslationRequestHash(request)

  // In-tab memory tier over the background cache, same hash identity.
  // Virtualized pages (X articles/timelines) destroy and recreate paragraph
  // nodes on scroll; the recreated nodes re-enter this pipeline for text the
  // tab already translated, and paying the message round trip again makes the
  // page visibly re-translate paragraph by paragraph. Scoped to
  // page-translation runs (sessionId) so input/selection behavior is
  // untouched; forceRetranslation bypasses the read exactly like it bypasses
  // the background cache, but its fresh result still lands in the store below.
  if (sessionId !== undefined && !forceRetranslation) {
    const memoryHit = getInMemoryTranslation(hash)
    if (memoryHit !== undefined) {
      return isNoTranslationSentinel(memoryHit) ? "" : memoryHit
    }
  }

  const result = await sendMessage("enqueueTranslateRequest", {
    ...request,
    scheduleAt: Date.now(),
    hash,
    sessionId,
    forceRetranslation,
  })
  if (sessionId !== undefined) {
    // Raw result, sentinel included, so a "no translation needed" verdict is
    // remembered too; the mapping below stays the single mapping point.
    storeInMemoryTranslation(hash, result)
  }
  // The sentinel must be mapped here and only here: every batch-pipeline
  // consumer (page paragraphs, document title, input translation, selection
  // toolbar standard path) routes through this function and already handles
  // "" gracefully. Mapping earlier — in the background — would fall out of
  // the truthy-only cache write and re-hit the provider on every request.
  return isNoTranslationSentinel(result) ? "" : result
}
