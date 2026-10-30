import type { Config } from "@/types/config/config"
import type { TranslateProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { LangCodeISO6393, LangLevel } from "@/utils/languages"
import type { ResolvedProviderRef } from "@/utils/providers/provider-registry"
import { toastManager } from "@/components/ui/base-ui/toast"
import { isAPIProviderConfig } from "@/types/config/provider"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { detectLanguage } from "@/utils/content/language"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { buildWebPageHashComponents, normalizeWebPagePromptContext } from "./translation-plan"
export { normalizePromptContextValue } from "./translation-plan"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { Sha256Hex } from "../../hash"
import { sendMessage } from "../../message"
import { getInMemoryTranslation, storeInMemoryTranslation } from "./in-memory-translation-cache"
import { prepareTranslationText } from "./text-preparation"
import { getPageTranslationSessionId } from "./translation-session"
import { isInPageAnchorChange } from "./webpage-context"

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

export interface TranslateTextOptions {
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
  promptConfig?: Pick<Config["pageTranslation"], "customPromptsConfig">
}

/**
 * Dispatch an isolated request snapshot. Page callers supply their prompt
 * configuration; legacy non-page callers resolve it once before planning.
 */
export async function translateTextCore(options: TranslateTextOptions): Promise<string> {
  const requestUrl = typeof location === "undefined" ? undefined : location.href
  const isLocationCurrent = () =>
    !requestUrl || requestUrl === location.href || isInPageAnchorChange(requestUrl, location.href)
  const snapshot = structuredClone({
    providerConfig: options.providerConfig,
    langConfig: options.langConfig,
    webPageContext: options.webPageContext,
    promptConfig: options.promptConfig,
  })
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
    promptConfig: suppliedPromptConfig,
  } = { ...options, ...snapshot }

  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  // Abort before planning if the session ended while context was preparing.
  if (
    sessionId !== undefined &&
    (getPageTranslationSessionId() !== sessionId || !isLocationCurrent())
  ) {
    throw new TranslationCancelledError(sessionId)
  }

  const promptConfig = suppliedPromptConfig ?? {
    customPromptsConfig: ((await getLocalConfig()) ?? DEFAULT_CONFIG).pageTranslation
      .customPromptsConfig,
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

  const hashComponents = buildWebPageHashComponents(
    preparedText,
    providerRef,
    { sourceCode: langConfig.sourceCode, targetCode: langConfig.targetCode },
    enableAIContentAware,
    textFormat,
    preserveLineBreaks,
    glossaryTerms,
    normalizedWebPageContext,
    promptConfig,
  )

  // Add extra hash tags for cache differentiation
  hashComponents.push(...extraHashTags)

  // Final gate before dispatch: if the page-translation session that owned
  // this request has ended (or been replaced) while we were preparing it,
  // abort instead of enqueueing. Sending now would either be unscoped (if the
  // id had gone null) or re-populate the queue AFTER the session's cancel
  // message already drained it — both defeat cancellation (#1881). Callers on
  // the page path swallow this error; input/selection requests carry no
  // sessionId and skip the gate entirely. The gate must also precede the
  // memory-tier read below: a cancelled session must not keep painting
  // translations out of memory.
  if (
    sessionId !== undefined &&
    (getPageTranslationSessionId() !== sessionId || !isLocationCurrent())
  ) {
    throw new TranslationCancelledError(sessionId)
  }

  const hash = Sha256Hex(...hashComponents)

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
    text: preparedText,
    langConfig,
    providerRef,
    scheduleAt: Date.now(),
    hash,
    textFormat,
    preserveLineBreaks,
    webTitle: normalizedWebPageContext?.webTitle,
    webDescription: normalizedWebPageContext?.webDescription,
    webContent: normalizedWebPageContext?.webContent,
    webSummary: normalizedWebPageContext?.webSummary,
    sessionId,
    forceRetranslation,
    glossaryTerms,
    glossaryRevision,
    promptConfig,
  })
  if (
    sessionId !== undefined &&
    (getPageTranslationSessionId() !== sessionId || !isLocationCurrent())
  )
    throw new TranslationCancelledError(sessionId)
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

export function validateTranslationConfigAndToast(
  config: Pick<Config, "providersConfig" | "pageTranslation" | "language">,
): boolean {
  const { providersConfig, pageTranslation: translateConfig, language: languageConfig } = config
  const provider = resolveProviderRefForCapability(
    "pageTranslation",
    providersConfig,
    translateConfig.providerId,
  )
  if (!provider) {
    return false
  }

  if (languageConfig.sourceCode === languageConfig.targetCode) {
    toastManager.add({ type: "error", title: i18n.t("translation.sameLanguage") })
    logger.info("validateTranslationConfig: returning false (same language)")
    return false
  }

  // check if the API key is configured
  if (
    provider.kind === "local" &&
    isAPIProviderConfig(provider.config) &&
    !provider.config.apiKey?.trim() &&
    !["deeplx", "ollama"].includes(provider.config.provider)
  ) {
    toastManager.add({ type: "error", title: i18n.t("noAPIKeyConfig.warning") })
    logger.info("validateTranslationConfig: returning false (no API key)")
    return false
  }

  return true
}
