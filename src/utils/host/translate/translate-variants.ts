import type { PageSession } from "./translation-session"
import type { InputTranslationLang } from "@/types/config/config"
import type { Config } from "@/types/config/config"
import type { TranslateProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { LangCodeISO6393 } from "@/utils/languages"
import type { ResolvedProviderRef } from "@/utils/providers/provider-registry"
import { getDetectedCodeFromStorage, getFinalSourceCode } from "@/utils/config/languages"
import { logger } from "@/utils/logger"
import { getContextRequirements } from "@/utils/prompts/translate"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import {
  canResolvedProviderRefGenerateText,
  resolvePageTranslationProvider,
} from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import {
  isTranslationCancelledError,
  TranslationCancelledError,
} from "@/utils/request/cancellation"
import { getLocalConfig } from "../../config/storage"
import { shouldSkipAsTargetLanguage } from "./target-language-skip"
import { prepareTranslationText } from "./text-preparation"
import {
  MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
  shouldSkipByLanguage,
  translateTextCore,
} from "./translate-text"
import { getPageTranslationSession } from "./translation-session"
import {
  getOrCreateWebPageContext,
  getWebPageContentRevision,
  waitForStableWebPageContext,
  ContextUnstableError,
  getDocumentContextSignal,
  isInPageAnchorChange,
  isWebPageContextCurrent,
} from "./webpage-context"
import { getOrGenerateWebPageSummary } from "./webpage-summary"

async function getConfigOrThrow(): Promise<Config> {
  const config = await getLocalConfig()
  if (!config) {
    throw new Error("No global config when translate text")
  }
  return config
}

async function getWebPagePromptContext(
  ...args: Parameters<typeof prepareWebPagePromptContext>
): ReturnType<typeof prepareWebPagePromptContext> {
  const session = args[4] === undefined ? (getPageTranslationSession() ?? null) : args[4]
  args[4] = session
  const url = window.location.href
  const signal = session?.signal ?? getDocumentContextSignal()
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = getWebPageContentRevision()
    try {
      return await prepareWebPagePromptContext(...args)
    } catch (error) {
      // An unaffected visible paragraph must not be stranded when another
      // region changes while its context is pending. Retry only content
      // invalidation, never a stopped session, navigation or provider error.
      if (
        !isTranslationCancelledError(error) ||
        session?.signal.aborted ||
        revision === getWebPageContentRevision() ||
        (url !== window.location.href && !isInPageAnchorChange(url, window.location.href))
      )
        throw error
      await waitForStableWebPageContext(signal)
    }
  }
  throw new ContextUnstableError()
}

async function prepareWebPagePromptContext(
  providerConfig: ResolvedProviderRef<TranslateProviderConfig>,
  enableAIContentAware: boolean,
  includeSummary: boolean,
  config: Config,
  session: PageSession | null = getPageTranslationSession() ?? null,
): Promise<
  { webTitle: string; webDescription?: string; webContent: string; webSummary?: string } | undefined
> {
  // Pure translate providers (Google, Microsoft, DeepLX) take no prompt

  if (!canResolvedProviderRefGenerateText(providerConfig)) {
    return undefined
  }

  const requirements = getContextRequirements(config.pageTranslation)
  const needsSummary = requirements.summary && includeSummary && enableAIContentAware
  if (!requirements.title && !requirements.description && !requirements.content && !needsSummary)
    return undefined
  const webPageContext = await getOrCreateWebPageContext(
    requirements.content || needsSummary,
    session?.signal,
  )
  if (!webPageContext) {
    return undefined
  }

  let webSummary: string | null | undefined
  if (needsSummary) {
    try {
      webSummary = await getOrGenerateWebPageSummary(
        webPageContext,
        serializeProviderRef(providerConfig),
        enableAIContentAware,
        session,
      )
    } catch (error) {
      if (
        isTranslationCancelledError(error) ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw error
      // Explicit upper-layer fallback, after RequestQueue exhausted retries.
      // Failed summaries remain temporary cooldown entries, never successes.
      logger.warn("Optional page summary failed after queue retry budget", error)
      webSummary = undefined
    }
  }

  if (!isWebPageContextCurrent(webPageContext)) throw new TranslationCancelledError(session?.id)
  return {
    webTitle: webPageContext.webTitle,
    webDescription: webPageContext.webDescription,
    webContent: webPageContext.webContent,
    webSummary: webSummary ?? undefined,
  }
}

export function primePageTranslationContext(config: Config): void {
  void getWebPagePromptContext(
    resolvePageTranslationProvider(config),
    config.pageTranslation.enableAIContentAware,
    true,
    config,
  ).catch((error) => {
    if (
      !isTranslationCancelledError(error) &&
      !(error instanceof Error && error.name === "AbortError")
    )
      logger.warn("Context prefetch failed", error)
  })
}

async function translateTextUsingPageConfig(
  config: Config,
  text: string,
  options: {
    extraHashTags?: string[]
    webPageContext?: {
      webTitle?: string | null
      webDescription?: string | null
      webContent?: string | null
      webSummary?: string | null
    }
    textFormat?: TranslationTextFormat
    preserveLineBreaks?: boolean
    // Session captured at pipeline entry by the caller; see translateTextForPage.
    sessionId?: string
    forceRetranslation?: boolean
  } = {},
): Promise<string> {
  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  const providerConfig = resolvePageTranslationProvider(config)

  // Backstop only: the page modes hoist this check before DOM insertion, but
  // other callers (e.g. the page title) still rely on it here.
  if (await shouldSkipAsTargetLanguage(preparedText, config)) {
    logger.info(
      `translateTextForPage: skipping translation because text is already in target language. text: ${preparedText}`,
    )
    return ""
  }

  // Skip translation if text is in skipLanguages list (page translation only)
  const { skipLanguages } = config.pageTranslation.page
  if (skipLanguages.length > 0 && preparedText.length >= MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION) {
    const shouldSkip = await shouldSkipByLanguage(preparedText, skipLanguages)
    if (shouldSkip) {
      logger.info(
        `translateTextForPage: skipping translation because text is in skip language list. text: ${preparedText}`,
      )
      return ""
    }
  }

  return translateTextCore({
    text: preparedText,
    langConfig: config.language,
    providerConfig,

    enableAIContentAware: config.pageTranslation.enableAIContentAware,
    glossaryEnabled: config.glossary.enabled,
    promptConfig: { customPromptsConfig: config.pageTranslation.customPromptsConfig },

    extraHashTags: options.extraHashTags,
    webPageContext: options.webPageContext,
    textFormat: options.textFormat,
    preserveLineBreaks: options.preserveLineBreaks,
    sessionId: options.sessionId,
    forceRetranslation: options.forceRetranslation,
  })
}

export interface PageTranslationRequestOptions {
  preserveLineBreaks?: boolean
  forceRetranslation?: boolean
}

/**
 * Page translation — uses FEATURE_PROVIDER_DEFS['translate'].
 * Includes skip-language logic (page translation only).
 */
export async function translateTextForPage(
  text: string,
  textFormat: TranslationTextFormat = "plain",
  options?: PageTranslationRequestOptions,
): Promise<string> {
  // Capture the session id synchronously at pipeline entry. Reading it later
  // (after the awaits below, e.g. the network-backed page summary) could see
  // null if the user cancelled mid-request — the request would then be sent
  // unscoped and stay permanently uncancellable, re-creating #1881.
  const session = getPageTranslationSession()
  const sessionId = session?.id
  const config = await getConfigOrThrow()
  const providerConfig = resolvePageTranslationProvider(config)
  const webPageContext = await getWebPagePromptContext(
    providerConfig,
    config.pageTranslation.enableAIContentAware,
    true,
    config,
    session,
  )

  return translateTextUsingPageConfig(config, text, {
    webPageContext,
    textFormat,
    preserveLineBreaks: options?.preserveLineBreaks,
    sessionId,
    forceRetranslation: options?.forceRetranslation,
  })
}

/**
 * Page title translation — uses page translation settings, but always treats the
 * current source title as the webpage title context.
 */
export async function translateTextForPageTitle(text: string): Promise<string> {
  const session = getPageTranslationSession()
  const sessionId = session?.id
  const config = await getConfigOrThrow()
  const providerConfig = resolvePageTranslationProvider(config)
  const webPageContext = config.pageTranslation.enableAIContentAware
    ? await getWebPagePromptContext(providerConfig, true, false, config, session)
    : undefined

  return translateTextUsingPageConfig(config, text, {
    extraHashTags: ["pageTitleTranslation"],
    webPageContext: {
      webTitle: text,
      webDescription: webPageContext?.webDescription,
      webContent: webPageContext?.webContent,
      webSummary: webPageContext?.webSummary,
    },
    sessionId,
  })
}

/**
 * Input translation — uses FEATURE_PROVIDER_DEFS['inputTranslation'].
 */

async function resolveInputLang(
  lang: InputTranslationLang,
  globalLangConfig: Config["language"],
): Promise<LangCodeISO6393> {
  if (lang === "sourceCode") {
    const detectedCode = await getDetectedCodeFromStorage()
    return getFinalSourceCode(globalLangConfig.sourceCode, detectedCode)
  }
  if (lang === "targetCode") {
    return globalLangConfig.targetCode
  }
  return lang
}

/**
 * Input translation — uses FEATURE_PROVIDER_DEFS['inputTranslation'].
 */
export async function translateTextForInput(
  text: string,
  fromLang: InputTranslationLang,
  toLang: InputTranslationLang,
  onTargetLanguageResolved?: (targetLanguage: LangCodeISO6393) => void,
): Promise<string> {
  const config = await getConfigOrThrow()
  // Capability-based, not resolveProviderConfig: that helper looks the id up in
  // providersConfig and throws for a built-in provider, which is never a row
  // there.
  const resolved = resolveProviderRefForCapability(
    "inputTranslation",
    config.providersConfig,
    config.inputTranslation.providerId,
  )
  if (!resolved) {
    throw new Error(`No input translation provider for id "${config.inputTranslation.providerId}"`)
  }

  const resolvedFromLang = await resolveInputLang(fromLang, config.language)
  const resolvedToLang = await resolveInputLang(toLang, config.language)
  onTargetLanguageResolved?.(resolvedToLang)

  if (resolvedFromLang === resolvedToLang) {
    return ""
  }

  const webPageContext = await getWebPagePromptContext(
    resolved,
    config.pageTranslation.enableAIContentAware,
    true,
    config,
    null,
  )

  return translateTextCore({
    text,
    langConfig: {
      sourceCode: resolvedFromLang,
      targetCode: resolvedToLang,
      level: config.language.level,
    },
    extraHashTags: [`inputTranslation:${fromLang}->${toLang}`],
    providerConfig: resolved,
    enableAIContentAware: config.pageTranslation.enableAIContentAware,
    glossaryEnabled: config.glossary.enabled,
    promptConfig: { customPromptsConfig: config.pageTranslation.customPromptsConfig },
    webPageContext,
    // User-typed newlines are always meaningful.
    preserveLineBreaks: true,
  })
}
