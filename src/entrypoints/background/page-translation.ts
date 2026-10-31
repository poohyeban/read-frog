import type { WebPagePromptContext } from "@/types/content"
import { browser } from "#imports"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import {
  assertHtmlAttributeMarkerIntegrity,
  hasHtmlAttributeMarkerProtocol,
  isHtmlAttributeMarkerIntegrityError,
} from "@/utils/host/translate/html-attribute-markers"
import {
  auditInlineAtomTokens,
  hasInlineAtomTokens,
} from "@/utils/host/translate/inline-atom-tokens"
import {
  normalizePromptContextValue,
  assertTranslationPlanIdentity,
} from "@/utils/host/translate/translation-plan"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  buildTranslationScopeKey,
  createWebPageTranslationQueues,
  getLocalProviderConfig,
  getQueuedTranslationRouting,
  shouldUseBatchQueue,
  providerExecutionKey,
} from "./translation-queues"

async function getValidatedCachedTranslation(
  hash: string,
  sourceText: string,
  validateHtmlAttributeMarkers: boolean,
): Promise<string | undefined> {
  const cached = await db.translationCache.get(hash)
  if (!cached) return undefined
  if (!validateHtmlAttributeMarkers) return cached.translation

  try {
    assertHtmlAttributeMarkerIntegrity(sourceText, cached.translation)
    return cached.translation
  } catch (error) {
    if (!isHtmlAttributeMarkerIntegrityError(error)) throw error

    await db.translationCache.delete(hash)
    logger.warn("Deleted cached translation with invalid HTML attribute markers")
    return undefined
  }
}

/** Register handlers synchronously while queue initialization runs in the background. */
export function setupPageTranslationHandlers(): void {
  const { queuesPromise, cancelledScopes } = createWebPageTranslationQueues()
  const tabScopes = new Map<number, Map<string, number>>()
  const trackScope = (sender: { tab?: { id?: number } } | undefined, sessionId?: string) => {
    const scope = buildTranslationScopeKey(sender, sessionId)
    const tabId = sender?.tab?.id
    if (scope && tabId !== undefined) {
      const scopes = tabScopes.get(tabId) ?? new Map<string, number>()
      scopes.set(scope, (scopes.get(scope) ?? 0) + 1)
      tabScopes.set(tabId, scopes)
    }
    return scope
  }

  const releaseScope = (tabId: number | undefined, scope: string | undefined) => {
    if (tabId === undefined || !scope) return
    const scopes = tabScopes.get(tabId)
    const count = scopes?.get(scope)
    if (count === undefined) return
    if (count > 1) scopes!.set(scope, count - 1)
    else scopes!.delete(scope)
    if (!scopes!.size) tabScopes.delete(tabId)
  }

  onMessage("enqueueTranslateRequest", async (message) => {
    const scope = trackScope(message.sender, message.data.sessionId)
    try {
      assertTranslationPlanIdentity(message.data)
      const routing = getQueuedTranslationRouting(message.data)
      const { requestQueue, batchQueue } = await queuesPromise
      const {
        data: {
          text,
          langConfig,
          providerRef,
          scheduleAt,
          hash,
          textFormat,
          preserveLineBreaks,
          webTitle,
          webDescription,
          webContent,
          webSummary,
          forceRetranslation = false,
          glossaryTerms,
          glossaryRevision,
          promptConfig,
        },
      } = message

      const validateHtmlAttributeMarkers =
        textFormat === "html" && hasHtmlAttributeMarkerProtocol(text)
      if (validateHtmlAttributeMarkers) {
        assertHtmlAttributeMarkerIntegrity(text, text)
      }

      // Check cache first — unless the user asked for a fresh translation. The
      // existing entry is left untouched unless the fresh request succeeds below.
      if (hash && !forceRetranslation) {
        const cachedTranslation = await getValidatedCachedTranslation(
          hash,
          text,
          validateHtmlAttributeMarkers,
        )
        if (cachedTranslation !== undefined) return cachedTranslation
      }

      // The cache lookup above yielded — the session's cancel may have drained
      // the queues while this handler was suspended. Enqueueing now would park
      // an undraininable task on a dead scope, so abort instead (the content
      // side swallows this error).
      if (scope && cancelledScopes.has(scope)) {
        throw new TranslationCancelledError(scope)
      }

      let result: string
      const context: WebPagePromptContext = {
        webTitle: normalizePromptContextValue(webTitle),
        webDescription: normalizePromptContextValue(webDescription),
        webContent: normalizePromptContextValue(webContent),
        webSummary: normalizePromptContextValue(webSummary),
      }

      if (shouldUseBatchQueue(providerRef)) {
        const data = {
          text,
          langConfig,
          ...routing,
          hash,
          scheduleAt,
          context,
          // Kept off `context`, which is part of the batch key — see
          // `mergeBatchGlossaryTerms`.
          glossaryTerms,
          glossaryRevision,
          scope,
          promptConfig,
        }
        const queued = await batchQueue.enqueue(data)
        result = typeof queued === "string" ? queued : queued.translation
      } else {
        const localProvider = getLocalProviderConfig(providerRef)
        if (!localProvider) {
          throw new Error("Invalid local page translation provider")
        }
        // Create thunk based on type and params
        const thunk = (signal?: AbortSignal) =>
          executeTranslate(text, langConfig, localProvider, getTranslatePrompt, {
            textFormat,
            preserveLineBreaks,
            signal,
          })
        result = await requestQueue.enqueue(thunk, scheduleAt, hash, scope ? [scope] : undefined, {
          providerKey: providerExecutionKey(providerRef),
        })
      }

      if (validateHtmlAttributeMarkers) {
        assertHtmlAttributeMarkerIntegrity(text, result)
      }

      // A response that dropped, invented or duplicated an inline-atom
      // placeholder is still rendered by the content script (the formulas are
      // appended) but must not be persisted: the next visit deserves a fresh
      // attempt instead of a permanently degraded paragraph. The sentinel is
      // exempt — "no translation needed" carries no placeholders by definition,
      // and auditing it as a total loss would make every already-in-target-language
      // paragraph containing a formula re-hit the provider on every page load.
      const inlineAtomTokensIntact =
        !hasInlineAtomTokens(text) ||
        isNoTranslationSentinel(result) ||
        auditInlineAtomTokens(text, result).ok
      if (result && !inlineAtomTokensIntact) {
        logger.warn("Inline atom placeholders were not preserved; result not cached")
      }

      // Cache the translation result if successful
      if (result && hash && inlineAtomTokensIntact) {
        await db.translationCache.put({
          key: hash,
          translation: result,
          createdAt: new Date(),
        })
      }

      return result
    } finally {
      releaseScope(message.sender?.tab?.id, scope)
    }
  })

  onMessage("getOrGenerateWebPageSummary", async (message) => {
    const scope = trackScope(message.sender, message.data.sessionId)
    try {
      const { requestQueue } = await queuesPromise
      const { webTitle, webContent, providerRef } = message.data

      if (!webTitle || !webContent) {
        return null
      }

      // The payload type forces senders to narrow, but the wire is a trust
      // boundary (a pre-update content script can send a translate-only ref).
      // Refuse like the subtitle summary handlers do: a queue task for a
      // provider with no model to prompt can only ever throw, after burning
      // its retries.
      if (!canProviderRefGenerateText(providerRef)) {
        return null
      }

      return await getOrGenerateTranslationContextSummary({
        ...message.data,
        title: webTitle,
        textContent: webContent,
        cacheKeyParts: [webTitle, Sha256Hex(cleanText(webContent))],
        requestQueue,
        scope,
        isScopeCancelled: (key) => cancelledScopes.has(key),
      })
    } finally {
      releaseScope(message.sender?.tab?.id, scope)
    }
  })

  onMessage("cancelPageTranslationRequests", async (message) => {
    const scope = buildTranslationScopeKey(message.sender, message.data.sessionId)
    if (!scope) return
    // Remember the scope BEFORE any await so enqueue handlers suspended on
    // the cache lookup refuse to enqueue after this drain.
    cancelledScopes.markScope(scope)
    if (message.sender.tab?.id !== undefined) tabScopes.get(message.sender.tab.id)?.delete(scope)
    const { requestQueue, batchQueue } = await queuesPromise
    // Batch queue first so pending batches cannot flush new request-queue
    // tasks between the two drains.
    const cancelledBatch = batchQueue.cancelByScope(scope)
    const cancelledRequests = requestQueue.cancelByScope(scope)
    if (cancelledBatch + cancelledRequests > 0) {
      logger.info(
        `Cancelled ${cancelledBatch + cancelledRequests} page-translation requests (scope: ${scope})`,
      )
    }
  })

  // Full-document navigation cannot rely on the old content script delivering
  // pagehide. Snapshot only existing scopes; the new document remains usable.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading") return
    const scopes = tabScopes.get(tabId)
    if (!scopes) return
    tabScopes.delete(tabId)
    scopes.forEach((_count, scope) => cancelledScopes.markScope(scope))
    void queuesPromise.then(({ requestQueue, batchQueue }) => {
      for (const scope of scopes.keys()) {
        batchQueue.cancelByScope(scope)
        requestQueue.cancelByScope(scope)
      }
    })
  })

  // A closed tab can never send its cancel message — sweep every scope the
  // tab ever registered (#1881).
  browser.tabs.onRemoved.addListener((tabId) => {
    tabScopes.delete(tabId)
    const prefix = `${tabId}:`
    cancelledScopes.markPrefix(prefix)
    void queuesPromise.then(({ requestQueue, batchQueue }) => {
      batchQueue.cancelWhere((scope) => scope.startsWith(prefix))
      requestQueue.cancelWhere((scope) => scope.startsWith(prefix))
    })
  })
}
