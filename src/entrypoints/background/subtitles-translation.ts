import type { SubtitlePromptContext } from "@/types/content"
import type { SubtitleBatchRequestPayload, SubtitleRequestPayload } from "@/types/subtitle-request"
import { browser } from "#imports"
import { getPerformanceSnapshot, initializePerformance } from "@/utils/config/performance"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex, Sha256Fields, safeLegacyFieldsHash } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { onMessage } from "@/utils/message"
import { getSubtitlesTranslatePromptFromConfig } from "@/utils/prompts/subtitles"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { SUBTITLE_TRACE_EVENTS } from "@/utils/subtitles/diagnostics"
import { subtitleFailure } from "@/utils/subtitles/result"
import {
  SUBTITLE_STREAM_PORT,
  subtitleStreamStrategy,
  type SubtitleStreamUpdate,
} from "@/utils/subtitles/stream-protocol"
import { createSubtitleTranslationPlan } from "@/utils/subtitles/translation-plan"
import {
  SUBTITLE_WORK_LIMITS,
  SubtitleWorkRejected,
  type SubtitleWorkContext,
} from "@/utils/subtitles/work-policy"
import { getCachedAiSegmentation, runAiSegmentSubtitles } from "./ai-segmentation"
import { createStreamPortHandler } from "./background-stream"
import { ensureInitializedConfig } from "./config"
import { setupSubtitleCandidateHandlers } from "./subtitle-candidates"
import { subscribeSubtitleStream } from "./subtitle-stream-updates"
import { subtitleWorkRuntime } from "./subtitle-work"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  buildTranslationScopeKey,
  createSubtitlesTranslationQueues,
  getLocalProviderConfig,
  shouldUseBatchQueue,
} from "./translation-queues"

/** Register synchronously; all model work shares the existing subtitle queues. */
export function setupSubtitlesTranslationHandlers(): void {
  setupSubtitleCandidateHandlers()
  onMessage("recordSubtitleDiagnostics", async ({ sender, data }) => {
    await initializePerformance()
    const enabled = getPerformanceSnapshot().subtitles.diagnostics
    subtitleWorkRuntime.setDiagnostics(enabled)
    if (
      !enabled ||
      typeof sender.tab?.id !== "number" ||
      !SUBTITLE_TRACE_EVENTS.includes(data.event) ||
      (data.lane && !["fast", "quality", "segmentation"].includes(data.lane)) ||
      !Number.isFinite(data.mediaTimeMs) ||
      (data.value !== undefined && !Number.isFinite(data.value)) ||
      !/^[a-f0-9-]{36}$/i.test(data.sessionId)
    )
      return
    subtitleWorkRuntime.note(data.event, data.lane, data.value ?? 1, {
      mediaTimeMs: data.mediaTimeMs,
      scope: subtitleWorkRuntime.traceIdentity(sender.tab.id, data.sessionId),
    })
  })
  const { queuesPromise, cancelledScopes } = createSubtitlesTranslationQueues()
  const tabFor = (sender: { tab?: { id?: number } } | undefined) => {
    if (typeof sender?.tab?.id !== "number") throw new SubtitleWorkRejected("lease")
    return sender.tab.id
  }
  onMessage("openSubtitleLease", ({ sender, data }) =>
    subtitleWorkRuntime.open(tabFor(sender), data.traceId),
  )
  onMessage("revokeSubtitleLease", async ({ sender, data }) => {
    const scopes = subtitleWorkRuntime.revoke(tabFor(sender), data.lease)
    scopes.forEach((scope) => cancelledScopes.markScope(scope))
    const { batchQueue, requestQueue } = await queuesPromise
    for (const scope of scopes) {
      batchQueue.cancelByScope(scope)
      requestQueue.cancelByScope(scope)
    }
  })
  onMessage("getSubtitleDiagnostics", () => subtitleWorkRuntime.snapshot())
  const scopeFor = (sender: { tab?: { id?: number } } | undefined, sessionId?: string) => {
    const scope = buildTranslationScopeKey(sender, sessionId)
    if (sessionId && !scope) throw new Error("Subtitle scope requires a sender tab")
    return scope
  }
  const assertCurrent = (scope?: string) => {
    if (scope && cancelledScopes.has(scope)) throw new TranslationCancelledError(scope)
  }
  const admit = (
    sender: { tab?: { id?: number } } | undefined,
    scope: string | undefined,
    work?: SubtitleWorkContext,
  ) => {
    assertCurrent(scope)
    if (!scope || !work) throw new SubtitleWorkRejected("lease")
    if (
      !Number.isFinite(work.start) ||
      !Number.isFinite(work.end) ||
      work.end < work.start ||
      work.end - work.start > SUBTITLE_WORK_LIMITS.mediaMs
    )
      throw new SubtitleWorkRejected("input-limit")
    subtitleWorkRuntime.register(tabFor(sender), scope, work)
  }
  onMessage("releaseSubtitleTask", ({ sender, data }) => {
    const scope = scopeFor(sender, data.sessionId)
    if (scope) subtitleWorkRuntime.release(scope)
  })
  const handleSingle = async (message: {
    data: SubtitleRequestPayload
    sender: { tab?: { id?: number } }
  }) => {
    let submitted = false
    const translate = async () => {
      const scope = scopeFor(message.sender, message.data.sessionId)
      admit(message.sender, scope, message.data.work)
      if (message.data.text.length > SUBTITLE_WORK_LIMITS.sourceCharacters)
        throw new SubtitleWorkRejected("input-limit")
      const { requestQueue, batchQueue } = await queuesPromise
      assertCurrent(scope)
      // Old content scripts get one intake snapshot; execution never re-reads config.
      const promptConfig =
        message.data.promptConfig ??
        (await ensureInitializedConfig())?.videoSubtitles ??
        DEFAULT_CONFIG.videoSubtitles
      const { request, legacyHash } = createSubtitleTranslationPlan(
        {
          ...message.data,
          promptConfig,
        },
        undefined,
        true,
      )
      if (
        message.data.promptConfig &&
        request.hash !== message.data.hash &&
        legacyHash !== message.data.hash
      )
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
      const useBatch = shouldUseBatchQueue(providerRef)
      // A batch result belongs to the complete rendered batch, not this cue.
      // Old per-cue LLM entries may contain a different neighbour/glossary union.
      const cached = useBatch ? undefined : await db.translationCache.get(hash)
      assertCurrent(scope)
      if (cached?.translation) return cached.translation
      const context: SubtitlePromptContext = { webTitle, webDescription, videoSummary: summary }
      let result: string
      let batchIdentity: { batchKey: string; batchIndex: number } | undefined
      // Timestamp is owned by the background; a sender cannot jump other tabs' work.
      const scheduleAt = Date.now()
      if (useBatch) {
        submitted = true
        const batchResult = await batchQueue.enqueue({
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
          priority: request.priority,
          work: message.data.work,
        })
        result = typeof batchResult === "string" ? batchResult : batchResult.translation
        if (typeof batchResult !== "string") batchIdentity = batchResult
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
        submitted = true
        result = await requestQueue.enqueue(thunk, scheduleAt, hash, scope ? [scope] : undefined, {
          priority: request.priority,
        })
      }
      assertCurrent(scope)
      if (!result.trim() && text.trim()) throw new Error("Empty subtitle translation")
      if (result && !useBatch)
        await db.translationCache.put({ key: hash, translation: result, createdAt: new Date() })
      return {
        translation: result,
        ...batchIdentity,
        glossaryRevision: message.data.glossaryRevision ?? 0,
      }
    }
    try {
      const result = await translate()
      const translation = typeof result === "string" ? result : result.translation
      return message.data.resultFormat === "outcome"
        ? {
            ...(typeof result === "string" ? {} : result),
            translation,
            outcome: { status: translation.trim() ? ("success" as const) : ("empty" as const) },
          }
        : translation
    } catch (error) {
      // Legacy content scripts still receive their original string/error protocol.
      if (message.data.resultFormat !== "outcome") throw error
      const outcome = subtitleFailure(error)
      if (submitted && outcome.status === "temporary" && outcome.code !== "queue-full")
        outcome.retryExhausted = true
      return { outcome }
    }
  }
  onMessage("enqueueSubtitlesTranslateRequest", handleSingle)
  const handleBatch = async (message: {
    data: SubtitleBatchRequestPayload
    sender: { tab?: { id?: number } }
  }) => {
    try {
      const { members, ...snapshot } = message.data
      snapshot.executionStrategy = subtitleStreamStrategy(snapshot)
      const scope = scopeFor(message.sender, snapshot.sessionId)
      admit(message.sender, scope, snapshot.work)
      if (
        !Array.isArray(members) ||
        !members.length ||
        members.length > SUBTITLE_WORK_LIMITS.cues ||
        members.some((member) => typeof member.text !== "string") ||
        members.reduce((sum, member) => sum + member.text.length, 0) >
          SUBTITLE_WORK_LIMITS.sourceCharacters
      )
        throw new SubtitleWorkRejected("input-limit")
      const { requestQueue: _requestQueue, batchQueue } = await queuesPromise
      assertCurrent(scope)
      const promptConfig =
        snapshot.promptConfig ??
        (await ensureInitializedConfig())?.videoSubtitles ??
        DEFAULT_CONFIG.videoSubtitles
      const requests = members.map(
        (member) => createSubtitleTranslationPlan({ ...snapshot, ...member, promptConfig }).request,
      )
      if (!shouldUseBatchQueue(snapshot.providerRef)) {
        return {
          results: await Promise.all(
            requests.map((data) =>
              handleSingle({ ...message, data: { ...data, resultFormat: "outcome" } }),
            ),
          ),
        }
      }
      const results = await batchQueue.enqueueBatch(
        requests.map((request) => ({
          text: request.text,
          langConfig: request.langConfig,
          provider: request.providerRef,
          hash: request.hash,
          scheduleAt: Date.now(),
          context: {
            webTitle: request.webTitle,
            webDescription: request.webDescription,
            videoSummary: request.summary,
          },
          glossaryTerms: request.glossaryTerms,
          glossaryRevision: request.glossaryRevision,
          scope,
          subtitlePromptConfig: promptConfig,
          priority: request.priority,
          work: snapshot.work,
          executionStrategy: snapshot.executionStrategy,
        })),
      )
      assertCurrent(scope)
      return {
        results: results.map((result) => {
          if (result.status === "rejected") return { outcome: subtitleFailure(result.reason) }
          const value =
            typeof result.value === "string" ? { translation: result.value } : result.value
          return {
            ...value,
            glossaryRevision: snapshot.glossaryRevision ?? 0,
            outcome: {
              status: value.translation.trim() ? ("success" as const) : ("empty" as const),
            },
          }
        }),
      }
    } catch (error) {
      return { outcome: subtitleFailure(error) }
    }
  }
  onMessage("enqueueSubtitlesTranslateBatch", handleBatch)
  browser.runtime?.onConnect?.addListener((port) => {
    if (port.name !== SUBTITLE_STREAM_PORT) return
    type Response =
      | { member: SubtitleStreamUpdate }
      | { result: Awaited<ReturnType<typeof handleBatch>> }
    createStreamPortHandler<SubtitleBatchRequestPayload, Response>(
      async (payload, options) => {
        const scope = scopeFor(port.sender, payload.sessionId)
        if (!scope) throw new SubtitleWorkRejected("lease")
        const unsubscribe = subscribeSubtitleStream(scope, (member) =>
          options.onChunk?.({ member }),
        )
        const cancel = () => {
          void cancelScope(scope).catch(() => {})
        }
        options.signal?.addEventListener("abort", cancel, { once: true })
        try {
          options.signal?.throwIfAborted()
          return { result: await handleBatch({ data: payload, sender: port.sender ?? {} }) }
        } finally {
          unsubscribe()
          options.signal?.removeEventListener("abort", cancel)
        }
      },
      (raw) => {
        const message = raw as {
          type?: string
          streamRequestId?: string
          payload?: SubtitleBatchRequestPayload
        }
        return message?.type === "start" &&
          typeof message.streamRequestId === "string" &&
          message.streamRequestId.length < 128 &&
          !!message.payload &&
          typeof message.payload.sessionId === "string" &&
          Array.isArray(message.payload.members) &&
          message.payload.members.length <= SUBTITLE_WORK_LIMITS.cues
          ? {
              success: true,
              message: {
                type: "start",
                streamRequestId: message.streamRequestId,
                payload: message.payload,
              },
            }
          : { success: false }
      },
    )(port)
  })
  onMessage("aiSegmentSubtitles", async (message) => {
    try {
      const scope = scopeFor(message.sender, message.data.sessionId)
      admit(message.sender, scope, message.data.work)
      const { requestQueue } = await queuesPromise
      assertCurrent(scope)
      const cached = await getCachedAiSegmentation(message.data)
      assertCurrent(scope)
      if (cached) {
        subtitleWorkRuntime.note("segmentation-cache-hit")
        return cached
      }
      const key = Sha256Fields(
        "subtitle-segmentation-v2",
        message.data.jsonContent,
        JSON.stringify(message.data.providerRef),
      )
      const result = await requestQueue.enqueue(
        (signal, liveScopes) =>
          runAiSegmentSubtitles(message.data, {
            signal,
            modelGuard: subtitleWorkRuntime.guard(
              liveScopes ?? (() => (scope ? [scope] : undefined)),
              [key],
              signal,
            ),
          }),
        Date.now(),
        key,
        scope ? [scope] : undefined,
        {
          priority: message.data.priority ?? 1,
        },
      )
      assertCurrent(scope)
      return result
    } catch (error) {
      if (message.data.resultFormat !== "outcome") throw error
      return { outcome: subtitleFailure(error) }
    }
  })
  onMessage("getSubtitlesSummary", async (message) => {
    try {
      const scope = scopeFor(message.sender, message.data.sessionId)
      admit(message.sender, scope, message.data.work)
      if (message.data.subtitlesContext.length > SUBTITLE_WORK_LIMITS.sourceCharacters)
        throw new SubtitleWorkRejected("input-limit")
      const { requestQueue } = await queuesPromise
      assertCurrent(scope)
      const { videoTitle, subtitlesContext, providerRef } = message.data
      if (!videoTitle || !subtitlesContext || !canProviderRefGenerateText(providerRef)) return null
      return await getOrGenerateTranslationContextSummary({
        title: videoTitle,
        textContent: subtitlesContext,
        providerRef,
        cacheKeyParts: [Sha256Fields(videoTitle, cleanText(subtitlesContext))],
        legacyCacheKeyParts: safeLegacyFieldsHash(videoTitle, cleanText(subtitlesContext))
          ? [Sha256Hex(videoTitle, cleanText(subtitlesContext))]
          : undefined,
        requestQueue,
        scope,
        priority: 3,
        isScopeCancelled: (key) => cancelledScopes.has(key),
        modelGuard: (liveScopes, signal) =>
          subtitleWorkRuntime.guard(
            liveScopes,
            [Sha256Hex("context", videoTitle, subtitlesContext)],
            signal,
          ),
      })
    } catch (error) {
      if (message.data.resultFormat !== "outcome") throw error
      return { outcome: subtitleFailure(error) }
    }
  })
  const cancelScope = async (scope: string) => {
    subtitleWorkRuntime.release(scope, true)
    cancelledScopes.markScope(scope)
    const { requestQueue, batchQueue } = await queuesPromise
    batchQueue.cancelByScope(scope)
    requestQueue.cancelByScope(scope)
  }
  onMessage("cancelSubtitleRequests", async (message) => {
    const scope = scopeFor(message.sender, message.data.sessionId)
    if (scope) await cancelScope(scope)
  })
  browser.tabs.onRemoved.addListener((tabId) => {
    subtitleWorkRuntime.closeTab(tabId)
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
