import type { Config } from "@/types/config/config"
import type { TranslateProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { LangCodeISO6393, LangLevel } from "@/utils/languages"
import type { ResolvedProviderRef } from "@/utils/providers/provider-registry"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { detectLanguage } from "@/utils/content/language"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { executeTranslationPlan } from "./translation-executor"
import { createTranslationPlan, type TranslationOrigin } from "./translation-plan"
export { normalizePromptContextValue } from "./translation-plan"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { prepareTranslationText } from "./text-preparation"
import { getPageTranslationSession, getPageTranslationSessionId } from "./translation-session"
import {
  getDocumentContextSignal,
  getWebPageContentRevision,
  isInPageAnchorChange,
} from "./webpage-context"

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
  origin?: TranslationOrigin
  mode?: Config["pageTranslation"]["mode"] | "independent"
  configRevision?: number
  documentRevision?: number
  signal?: AbortSignal
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
  requestScopeId?: string
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
  const providerRef = serializeProviderRef(providerConfig)
  const { terms: glossaryTerms, revision: glossaryRevision } = await resolveGlossaryTerms(
    preparedText,
    glossaryEnabled,
    langConfig.targetCode,
  )
  const plan = createTranslationPlan({
    origin: options.origin ?? (sessionId ? "page" : "independent"),
    mode: options.mode ?? "independent",
    configRevision: options.configRevision ?? 0,
    documentRevision: options.documentRevision ?? getWebPageContentRevision(),
    text: preparedText,
    providerRef,
    langConfig,
    promptConfig,
    context: webPageContext,
    contextAware: enableAIContentAware,
    glossaryTerms,
    glossaryRevision,
    textFormat,
    preserveLineBreaks,
    forceRetranslation,
    extraHashTags,
    scope: {
      kind: sessionId ? "page" : "independent",
      id: options.requestScopeId ?? sessionId ?? `request-${crypto.randomUUID()}`,
    },
  })
  const signal =
    options.signal ?? (sessionId ? getPageTranslationSession()?.signal : getDocumentContextSignal())
  const result = await executeTranslationPlan(plan, {
    signal,
    activitySessionId: sessionId,
    isCurrent: () =>
      isLocationCurrent() &&
      (sessionId === undefined || getPageTranslationSessionId() === sessionId),
  })
  return result.text
}
