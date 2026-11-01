import type { TranslationTaskOwner } from "./context/task-owner"
import type { ContextSource } from "./context/types"
import type { InputTranslationLang } from "@/types/config/config"
import type { Config } from "@/types/config/config"
import type { TranslateProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { LangCodeISO6393 } from "@/utils/languages"
import type { ResolvedProviderRef } from "@/utils/providers/provider-registry"
import { getDetectedCodeFromStorage, getFinalSourceCode } from "@/utils/config/languages"
import {
  captureInputConfigValidity,
  getConfigSnapshotRevision,
} from "@/utils/config/snapshot-revision"
import { logger } from "@/utils/logger"
import { getContextRequirements } from "@/utils/prompts/translate"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import {
  canResolvedProviderRefGenerateText,
  resolvePageTranslationProvider,
} from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { getLocalConfig } from "../../config/storage"
import { requiresModelSummary } from "./context/summary-policy"
import { translationActivity } from "./engine-state"
import { shouldSkipAsTargetLanguage } from "./target-language-skip"
import { prepareTranslationText } from "./text-preparation"
import {
  MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
  shouldSkipByLanguage,
  translateTextCore,
} from "./translate-text"
import { getPageTranslationSession } from "./translation-session"
import { getOrCreateWebPageContext, getDocumentContextSignal } from "./webpage-context"
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
  const owner = args[4]
  const finish = translationActivity.track("context", owner?.id)
  try {
    return await prepareWebPagePromptContext(...args)
  } catch (error) {
    finish(error)
    throw error
  } finally {
    finish()
  }
}

async function prepareWebPagePromptContext(
  providerConfig: ResolvedProviderRef<TranslateProviderConfig>,
  enableAIContentAware: boolean,
  includeSummary: boolean,
  config: Config,
  session: TranslationTaskOwner | null = null,
  source: ContextSource = {},
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
    { ...source, requirements: { ...requirements, summary: needsSummary } },
  )
  if (!webPageContext) {
    return undefined
  }

  const webSummary = needsSummary
    ? await getOrGenerateWebPageSummary(
        webPageContext,
        serializeProviderRef(providerConfig),
        true,
        session,
        { requireModel: requiresModelSummary(config.pageTranslation) },
      )
    : undefined

  if (session?.signal.aborted) throw new TranslationCancelledError(session.id)
  return {
    webTitle: requirements.title ? webPageContext.webTitle : "",
    webDescription: requirements.description ? webPageContext.webDescription : undefined,
    webContent: requirements.content ? webPageContext.webContent : "",
    webSummary: webSummary ?? undefined,
  }
}

async function translateTextUsingPageConfig(
  config: Config,
  text: string,
  options: {
    origin?: "page" | "page-title"
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
    signal?: AbortSignal
    isCurrent?: () => boolean
    requestScopeId?: string
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
    origin: options.origin ?? "page",
    mode: config.pageTranslation.mode,
    configRevision: getConfigSnapshotRevision(config),
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
    signal: options.signal,
    isCurrent: options.isCurrent,
    requestScopeId: options.requestScopeId,
    forceRetranslation: options.forceRetranslation,
  })
}

export interface PageTranslationRequestOptions extends ContextSource {
  owner?: TranslationTaskOwner | null
  isSourceCurrent?: () => boolean
  config?: Config
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
  const page = getPageTranslationSession()
  const owner = options?.owner === undefined ? (page ?? null) : options.owner
  const sessionId = owner === page ? page?.id : undefined
  const config = options?.config ?? (await getConfigOrThrow())
  const providerConfig = resolvePageTranslationProvider(config)
  const webPageContext = await getWebPagePromptContext(
    providerConfig,
    config.pageTranslation.enableAIContentAware,
    true,
    config,
    owner,
    options,
  )
  if (owner?.signal.aborted) throw new TranslationCancelledError(owner.id)
  return translateTextUsingPageConfig(config, text, {
    webPageContext,
    textFormat,
    preserveLineBreaks: options?.preserveLineBreaks,
    sessionId,
    signal: owner?.signal,
    isCurrent: options?.isSourceCurrent,
    requestScopeId: owner?.id,
    forceRetranslation: options?.forceRetranslation,
  })
}

/**
 * Page title translation — uses page translation settings, but always treats the
 * current source title as the webpage title context.
 */
export async function translateTextForPageTitle(
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const parent = getPageTranslationSession()
  const session =
    parent && signal ? { ...parent, signal: AbortSignal.any([parent.signal, signal]) } : parent
  const sessionId = session?.id
  const config = await getConfigOrThrow()
  const providerConfig = resolvePageTranslationProvider(config)
  const webPageContext = config.pageTranslation.enableAIContentAware
    ? await getWebPagePromptContext(providerConfig, true, false, config, session)
    : undefined

  return translateTextUsingPageConfig(config, text, {
    origin: "page-title",
    extraHashTags: ["pageTitleTranslation"],
    signal: session?.signal ?? signal,
    requestScopeId: signal ? `title-${crypto.randomUUID()}` : undefined,
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
  options?: ContextSource & { owner?: TranslationTaskOwner; isSourceCurrent?: () => boolean },
): Promise<string> {
  const config = await getConfigOrThrow()
  const configCurrent = captureInputConfigValidity(config)
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
    options?.owner ?? null,
    options ?? { kind: "independent", text },
  )

  if (!configCurrent()) throw new TranslationCancelledError(options?.owner?.id)
  const translated = await translateTextCore({
    signal: options?.owner?.signal ?? getDocumentContextSignal(),
    requestScopeId: options?.owner?.id,
    isCurrent: () => configCurrent() && options?.isSourceCurrent?.() !== false,
    origin: "input",
    mode: "independent",
    configRevision: getConfigSnapshotRevision(config),
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
  if (!configCurrent()) throw new TranslationCancelledError(options?.owner?.id)
  return translated
}
