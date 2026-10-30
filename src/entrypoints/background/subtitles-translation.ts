import type { SubtitlePromptContext } from "@/types/content"
import { browser } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { onMessage } from "@/utils/message"
import { getSubtitlesTranslatePromptFromConfig } from "@/utils/prompts/subtitles"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { createSubtitleTranslationPlan } from "@/utils/subtitles/translation-plan"
import { runAiSegmentSubtitles } from "./ai-segmentation"
import { ensureInitializedConfig } from "./config"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  buildTranslationScopeKey,
  createSubtitlesTranslationQueues,
  getLocalProviderConfig,
  shouldUseBatchQueue,
} from "./translation-queues"

/** Register synchronously; all model work shares the existing subtitle queues. */
export function setupSubtitlesTranslationHandlers(): void {
  const { queuesPromise, cancelledScopes } = createSubtitlesTranslationQueues()
  const scopeFor = (sender: { tab?: { id?: number } } | undefined, sessionId?: string) => {
    const scope = buildTranslationScopeKey(sender, sessionId)
    if (sessionId && !scope) throw new Error("Subtitle scope requires a sender tab")
    return scope
  }
  const assertCurrent = (scope?: string) => {
    if (scope && cancelledScopes.has(scope)) throw new TranslationCancelledError(scope)
  }
  onMessage("enqueueSubtitlesTranslateRequest", async (message) => {
    const scope = scopeFor(message.sender, message.data.sessionId)
    const { requestQueue, batchQueue } = await queuesPromise
    assertCurrent(scope)
    // Old content scripts get one intake snapshot; execution never re-reads config.
    const promptConfig =
      message.data.promptConfig ??
      (await ensureInitializedConfig())?.videoSubtitles ??
      DEFAULT_CONFIG.videoSubtitles
    const { request } = createSubtitleTranslationPlan({ ...message.data, promptConfig })
    if (message.data.promptConfig && request.hash !== message.data.hash)
      throw new Error("Subtitle request identity does not match its snapshot")
    const {
      text,
      langConfig,
      providerRef,
      hash,
      webTitle,
      webDescription,
      summary,
      glossaryTerms,
      glossaryRevision,
    } = request
    const cached = await db.translationCache.get(hash)
    assertCurrent(scope)
    if (cached?.translation) return cached.translation
    const context: SubtitlePromptContext = { webTitle, webDescription, videoSummary: summary }
    let result: string
    // Timestamp is owned by the background; a sender cannot jump other tabs' work.
    const scheduleAt = Date.now()
    if (shouldUseBatchQueue(providerRef)) {
      result = await batchQueue.enqueue({
        text,
        langConfig,
        provider: providerRef,
        hash,
        scheduleAt,
        context,
        glossaryTerms,
        glossaryRevision,
        scope,
        subtitlePromptConfig: promptConfig,
      })
    } else {
      const thunk = (signal?: AbortSignal) =>
        executeTranslate<SubtitlePromptContext>(
          text,
          langConfig,
          getLocalProviderConfig(providerRef),
          async (language, input, options) =>
            getSubtitlesTranslatePromptFromConfig(promptConfig, language, input, options),
          { signal, glossaryTerms },
        )
      result = await requestQueue.enqueue(thunk, scheduleAt, hash, scope ? [scope] : undefined)
    }
    assertCurrent(scope)
    if (!result.trim() && text.trim()) throw new Error("Empty subtitle translation")
    if (result)
      await db.translationCache.put({ key: hash, translation: result, createdAt: new Date() })
    return result
  })
  onMessage("aiSegmentSubtitles", async (message) => {
    const scope = scopeFor(message.sender, message.data.sessionId)
    const { requestQueue } = await queuesPromise
    assertCurrent(scope)
    const key = Sha256Hex(
      "subtitle-segmentation-v2",
      message.data.jsonContent,
      JSON.stringify(message.data.providerRef),
    )
    const result = await requestQueue.enqueue(
      (signal) => runAiSegmentSubtitles(message.data, { signal }),
      Date.now(),
      key,
      scope ? [scope] : undefined,
      { timeoutMs: 60_000 },
    )
    assertCurrent(scope)
    return result
  })
  onMessage("getSubtitlesSummary", async (message) => {
    const scope = scopeFor(message.sender, message.data.sessionId)
    const { requestQueue } = await queuesPromise
    assertCurrent(scope)
    const { videoTitle, subtitlesContext, providerRef } = message.data
    if (!videoTitle || !subtitlesContext || !canProviderRefGenerateText(providerRef)) return null
    return getOrGenerateTranslationContextSummary({
      title: videoTitle,
      textContent: subtitlesContext,
      providerRef,
      cacheKeyParts: [Sha256Hex(cleanText(subtitlesContext))],
      requestQueue,
      scope,
      isScopeCancelled: (key) => cancelledScopes.has(key),
    })
  })
  onMessage("cancelSubtitleRequests", async (message) => {
    const scope = scopeFor(message.sender, message.data.sessionId)
    if (!scope) return
    cancelledScopes.markScope(scope)
    const { requestQueue, batchQueue } = await queuesPromise
    batchQueue.cancelByScope(scope)
    requestQueue.cancelByScope(scope)
  })
  browser.tabs.onRemoved.addListener((tabId) => {
    const prefix = `${tabId}:`
    cancelledScopes.markPrefix(prefix)
    void queuesPromise
      .then(({ requestQueue, batchQueue }) => {
        const matches = (scope: string) => scope.startsWith(prefix)
        batchQueue.cancelWhere(matches)
        requestQueue.cancelWhere(matches)
      })
      .catch(() => {})
  })
}
