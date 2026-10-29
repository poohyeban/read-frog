import type { SubtitlesFragment } from "../types"
import type { Config } from "@/types/config/config"
import type { SubtitlePromptContext } from "@/types/content"
import type { TranslatePromptResult } from "@/utils/prompts/translate"
import type { PromptableProviderRef, SerializableProviderRef } from "@/utils/providers/provider-ref"
import { APICallError } from "ai"
import { isLLMProviderConfig } from "@/types/config/provider"
import { getLocalConfig } from "@/utils/config/storage"
import { cleanText } from "@/utils/content/utils"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { Sha256Hex } from "@/utils/hash"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import { normalizePromptContextValue } from "@/utils/prompts/context"
import { getTranslationRequestHash } from "@/utils/prompts/request-identity"
import { selectSubtitlePrompt } from "@/utils/prompts/subtitles"
import {
  canResolvedProviderRefGenerateText,
  getProviderCacheIdentity,
  serializeProviderRef,
} from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"

/**
 * One toast for the whole run, not one per batch: the provider is re-resolved
 * per ≤5-cue batch, and every batch of a video hits the same verdict.
 */

/**
 * What the resolved provider is being asked to do. Line translation is the
 * capability the provider list is gated on, so any resolved provider can run
 * it; a summary or a recut is a generation, which only a promptable provider
 * can run — the resolution reports that as its own state instead of handing
 * out a ref the task can only throw on.
 */
export type SubtitlesTask = "lineTranslation" | "summary" | "segmentation"

/**
 * Line translation and the summary bill against `videoSubtitles`; segmentation
 * has its own route for the wider output budget, but `getHostedFeatureForRoute`
 * collapses it back onto the same status gate.
 */

function toFriendlyErrorMessage(error: unknown): string {
  if (error instanceof APICallError) {
    switch (error.statusCode) {
      case 429:
        return i18n.t("subtitles.errors.aiRateLimited")
      case 401:
      case 403:
        return i18n.t("subtitles.errors.aiAuthFailed")
      case 500:
      case 502:
      case 503:
        return i18n.t("subtitles.errors.aiServiceUnavailable")
      default:
        break
    }
  }

  const message = error instanceof Error ? error.message : String(error)

  if (message.includes("No Response") || message.includes("Empty response")) {
    return i18n.t("subtitles.errors.aiNoResponse")
  }

  return message
}

export interface SubtitlesVideoContext {
  videoTitle: string
  videoDescription?: string | null
  subtitlesTextContent: string
  summary?: string | null
}

export function buildSubtitlesSummaryContextHash(
  videoContext: Pick<SubtitlesVideoContext, "subtitlesTextContent">,
  providerRef?: SerializableProviderRef,
): string | undefined {
  const preparedText = cleanText(videoContext.subtitlesTextContent)
  if (!preparedText) {
    return undefined
  }

  const textHash = Sha256Hex(preparedText)
  return Sha256Hex(textHash, providerRef ? getProviderCacheIdentity(providerRef) : "")
}

function normalizeSubtitlePromptContext(
  videoContext: SubtitlesVideoContext,
): SubtitlePromptContext {
  return {
    webTitle: normalizePromptContextValue(videoContext.videoTitle),
    webDescription: normalizePromptContextValue(videoContext.videoDescription),
    videoSummary: normalizePromptContextValue(videoContext.summary),
  }
}

async function translateSingleSubtitle(
  text: string,
  langConfig: Config["language"],
  providerRef: SerializableProviderRef,
  enableAIContentAware: boolean,
  glossaryEnabled: boolean,
  videoContext: SubtitlesVideoContext,
  promptTemplate: TranslatePromptResult,
): Promise<string> {
  const subtitlePromptContext = normalizeSubtitlePromptContext(videoContext)
  // Resolved once on the page, where the URL says which glossaries apply, and
  // then carried by the request — the background serves every tab at once.
  const { terms: glossaryTerms, revision: glossaryRevision } = await resolveGlossaryTerms(
    prepareTranslationText(text),
    glossaryEnabled,
    langConfig.targetCode,
  )

  const request = {
    text: prepareTranslationText(text),
    langConfig,
    providerRef,
    snapshot: {
      version: 2 as const,
      kind: "subtitles" as const,
      template: isLLMProviderConfig(providerRef.config)
        ? { ...promptTemplate }
        : { systemPrompt: "", prompt: "" },
      glossaryEnabled,
      contentAware: enableAIContentAware,
    },
    webTitle: subtitlePromptContext.webTitle,
    webDescription: subtitlePromptContext.webDescription,
    summary: enableAIContentAware ? subtitlePromptContext.videoSummary : undefined,
    glossaryTerms,
    glossaryRevision,
  }
  return await sendMessage("enqueueSubtitlesTranslateRequest", {
    ...request,
    scheduleAt: Date.now(),
    hash: getTranslationRequestHash(request),
  })
}

export type SubtitlesProviderResolution<
  Ref extends SerializableProviderRef = SerializableProviderRef,
> = { status: "ok"; ref: Ref } | { status: "notPromptable" } | { status: "none" }

export async function resolveSubtitlesProvider(
  config: Config,
  task: "lineTranslation",
): Promise<SubtitlesProviderResolution>
export async function resolveSubtitlesProvider(
  config: Config,
  task: "summary" | "segmentation",
): Promise<SubtitlesProviderResolution<PromptableProviderRef>>
export async function resolveSubtitlesProvider(
  config: Config,
  task: SubtitlesTask,
): Promise<SubtitlesProviderResolution>
export async function resolveSubtitlesProvider(
  config: Config,
  task: SubtitlesTask,
): Promise<SubtitlesProviderResolution> {
  const resolved = resolveProviderRefForCapability(
    "videoSubtitles",
    config.providersConfig,
    config.videoSubtitles.providerId,
  )
  if (!resolved) {
    return { status: "none" }
  }
  try {
    if (task !== "lineTranslation") {
      // A summary or a recut is a generation, but the subtitles provider list
      // is gated on the wider translate capability — so the default Microsoft
      // provider resolves here legally and then cannot be prompted. Refuse
      // before serializing: no ref a caller could misuse, and no doomed

      if (!canResolvedProviderRefGenerateText(resolved)) {
        return { status: "notPromptable" }
      }
      return { status: "ok", ref: serializeProviderRef(resolved) }
    }
    return { status: "ok", ref: serializeProviderRef(resolved) }
  } catch {
    // Nothing else is expected to throw here (serializeProviderRef already
    // fails open on an unreachable status endpoint). Keep degrading rather
    // than introducing a new throw into the render path, but leave a trace.
    logger.warn("[Subtitles] Provider ref resolution failed")
    return { status: "none" }
  }
}

export async function resolveSubtitlesProviderRef(
  config: Config,
  task: "lineTranslation",
): Promise<SerializableProviderRef | null>
export async function resolveSubtitlesProviderRef(
  config: Config,
  task: "summary" | "segmentation",
): Promise<PromptableProviderRef | null>
export async function resolveSubtitlesProviderRef(
  config: Config,
  task: SubtitlesTask,
): Promise<SerializableProviderRef | null> {
  const resolution = await resolveSubtitlesProvider(config, task)

  // user was refused), it is a configuration state the pre-flight UI explains.
  return resolution.status === "ok" ? resolution.ref : null
}

export async function fetchSubtitlesSummary(
  videoContext: SubtitlesVideoContext,
  configOverride?: Config,
  providerRef?: PromptableProviderRef | null,
): Promise<string | null> {
  // Tri-state ref: a session that already resolved and narrowed its ref passes
  // it through — re-resolving could mint a different cache identity mid-session

  // narrowed to "no promptable provider": skip outright, no message. Omitted
  // means "resolve here" (standalone callers).
  if (providerRef === null) {
    return null
  }

  const config = configOverride ?? (await getLocalConfig())
  if (!config?.pageTranslation.enableAIContentAware) {
    return null
  }

  const ref = providerRef ?? (await resolveSubtitlesProviderRef(config, "summary"))
  if (!ref) {
    return null
  }

  if (!videoContext.videoTitle || !videoContext.subtitlesTextContent) {
    return null
  }

  return await sendMessage("getSubtitlesSummary", {
    videoTitle: videoContext.videoTitle,
    subtitlesContext: videoContext.subtitlesTextContent,
    providerRef: ref,
  })
}

export async function translateSubtitles(
  fragments: SubtitlesFragment[],
  videoContext: SubtitlesVideoContext,
  configOverride?: Config,
): Promise<SubtitlesFragment[]> {
  const config = configOverride ?? (await getLocalConfig())
  if (!config) {
    return fragments.map((f) => ({ ...f, translation: "" }))
  }

  const providerRef = await resolveSubtitlesProviderRef(config, "lineTranslation")
  if (!providerRef) {
    return fragments.map((f) => ({ ...f, translation: "" }))
  }

  const langConfig = config.language
  const enableAIContentAware = config.pageTranslation.enableAIContentAware

  const translationPromises = fragments.map((fragment) =>
    translateSingleSubtitle(
      fragment.text,
      langConfig,
      providerRef,
      enableAIContentAware,
      config.glossary.enabled,
      videoContext,
      selectSubtitlePrompt(config.videoSubtitles),
    ),
  )

  const results = await Promise.allSettled(translationPromises)

  // If all translations failed, throw with friendly error message
  const allRejected = results.every((r): r is PromiseRejectedResult => r.status === "rejected")
  if (allRejected && results.length) {
    throw new Error(toFriendlyErrorMessage(results[0]!.reason))
  }

  return fragments.map((fragment, index) => {
    const result = results[index]
    return {
      ...fragment,
      translation: result!.status === "fulfilled" ? result!.value : "",
    }
  })
}
