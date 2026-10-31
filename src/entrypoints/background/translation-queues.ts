import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { SubtitlePromptContext } from "@/types/content"
import type { WebPagePromptContext } from "@/types/content"
import type { ProviderRequestRouting } from "@/types/provider-request"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { PromptResolver } from "@/utils/host/translate/api/ai"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import type { BatchPerformance } from "@/utils/request/performance-config"
import { isLLMProviderConfig } from "@/types/config/provider"
import {
  getPerformanceSnapshot,
  initializePerformance,
  watchPerformance,
} from "@/utils/config/performance"
import { BATCH_SEPARATOR, BATCH_SEPARATOR_LINE_PATTERN } from "@/utils/constants/prompt"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { LANG_CODE_TO_EN_NAME } from "@/utils/languages"
import { logger } from "@/utils/logger"
import {
  getSubtitlesTranslatePrompt,
  getSubtitlesTranslatePromptFromConfig,
} from "@/utils/prompts/subtitles"
import { getTranslatePrompt, getTranslatePromptFromConfig } from "@/utils/prompts/translate"
import { BatchCountMismatchError, BatchQueue } from "@/utils/request/batch-queue"
import { CancelledScopeRegistry } from "@/utils/request/cancellation"
import { RequestQueue } from "@/utils/request/request-queue"
import { RESOURCE_DEFAULTS } from "@/utils/request/resource-policy"
import {
  subtitleOutputLimit,
  SUBTITLE_WORK_LIMITS,
  type SubtitleModelGuard,
  type SubtitleWorkContext,
} from "@/utils/subtitles/work-policy"
import { ensureInitializedConfig } from "./config"
import { subtitleWorkRuntime } from "./subtitle-work"

type QueuedTranslationProvider = ProviderConfig | SerializableProviderRef

type QueuedTranslationRouting = { provider: QueuedTranslationProvider }

export function getQueuedTranslationRouting(
  request: ProviderRequestRouting,
): QueuedTranslationRouting {
  return { provider: request.providerRef }
}

export function getLocalProviderConfig(provider: QueuedTranslationProvider): ProviderConfig {
  return "kind" in provider ? provider.config : provider
}

function getQueuedProviderId(provider: QueuedTranslationProvider): string {
  return getLocalProviderConfig(provider).id
}

async function executeQueuedTranslation<TContext>(
  text: string,
  langConfig: Config["language"],
  routing: QueuedTranslationRouting,
  promptResolver: PromptResolver<TContext>,
  options: {
    isBatch?: boolean
    context?: TContext
    textFormat?: import("@/types/config/translate").TranslationTextFormat
    preserveLineBreaks?: boolean
    signal?: AbortSignal
    modelGuard?: SubtitleModelGuard
    maxOutputTokens?: number

    glossaryTerms?: readonly MatchedTerm[]
  } = {},
): Promise<string> {
  return executeTranslate(
    text,
    langConfig,
    getLocalProviderConfig(routing.provider),
    promptResolver,
    options,
  )
}

export function parseBatchResult(result: string): string[] {
  return result
    .trim()
    .split(BATCH_SEPARATOR_LINE_PATTERN)
    .map((t) => t.trim())
}

export function shouldUseBatchQueue(provider: QueuedTranslationProvider): boolean {
  const local = getLocalProviderConfig(provider)
  return local ? isLLMProviderConfig(local) : true
}

/**
 * The glossary terms for a whole batch: every member's terms, deduped.
 *
 * Each item resolved its own terms against its own text, so the union is what
 * the joined text would have matched — minus any term that only appears to span
 * the separator between two paragraphs, which was never really there.
 *
 * The term LIST is deliberately not part of `getBatchKey` — it differs per
 * paragraph, so keying on it would put every paragraph in a batch of its own and
 * end batching for anyone using a glossary. The glossary REVISION is in the key
 * instead: one global counter that every paragraph of a page carries alike, so
 * it costs nothing in the steady state while guaranteeing that a batch holds
 * exactly one glossary state.
 *
 * That guarantee is what makes this union sound, and it cannot be recovered by
 * any rule applied here, because a term's ABSENCE from a member is overloaded:
 * "the user deleted it", "my text does not contain it", "the feature was
 * switched off mid-page" (which bumps no revision at all) and "my snapshot timed
 * out" are the same value. Without the key component, a member carrying an
 * emptied list could not out-vote an older member's term, the prompt would apply
 * the removed wording to that member's text, and the result would be cached
 * under a hash built with NO terms — the hash a re-translation computes too, so
 * nothing would ever evict it.
 *
 * The revision comparison below is therefore defence in depth rather than the
 * live mechanism, kept so that a future change to the batch key cannot silently
 * reintroduce the mixed-state batch. What IS still live is the tie: equal
 * revisions carrying DIFFERENT wordings cannot happen within one glossary state,
 * so it means the stamp is not trustworthy for that key — `readSnapshot` reads
 * the revision and the entries separately while a writer commits its rows before
 * bumping, leaving a sub-millisecond window where post-edit entries come back
 * under a pre-edit revision. There the term is DROPPED rather than guessed at:
 * sending no instruction costs the user the wording once, whereas guessing sends
 * a wording that is wrong half the time and then caches it.
 */
function mergeBatchGlossaryTerms<TContext>(
  dataList: readonly TranslateBatchData<TContext>[],
): MatchedTerm[] | undefined {
  // `undefined` means "nobody resolved terms", which lets the prompt resolver
  // fall back to resolving them itself. An empty array means "resolved, nothing
  // matched" and must suppress that fallback.
  if (dataList.every((data) => data.glossaryTerms === undefined)) return undefined

  const byMatchKey = new Map<string, { term: MatchedTerm; revision: number }>()
  // Keys whose wording two members disagreed on at the SAME revision. Cleared
  // again if a strictly newer revision turns up, which settles the key outright.
  const unresolvable = new Set<string>()

  for (const data of dataList) {
    // Absent for a sender that predates the field (an old content script still
    // live across an update). 0 loses every disagreement, which is the safe way
    // round: a member that cannot say how fresh its terms are never displaces
    // one that can.
    const revision = data.glossaryRevision ?? 0
    for (const term of data.glossaryTerms ?? []) {
      const existing = byMatchKey.get(term.matchKey)
      if (existing === undefined) {
        byMatchKey.set(term.matchKey, { term, revision })
        continue
      }
      if (revision > existing.revision) {
        byMatchKey.set(term.matchKey, { term, revision })
        unresolvable.delete(term.matchKey)
        continue
      }
      if (revision === existing.revision && !isSameWording(existing.term, term)) {
        unresolvable.add(term.matchKey)
      }
    }
  }

  for (const matchKey of unresolvable) byMatchKey.delete(matchKey)

  return [...byMatchKey.values()]
    .map(({ term }) => term)
    .sort((a, b) => a.matchKey.localeCompare(b.matchKey))
}

/**
 * Whether two hits on one `matchKey` say the same thing.
 *
 * All three fields come from the indexed glossary entry rather than from the
 * page's surface text (`utils/glossary/matcher.ts`), so two hits produced from
 * the same glossary state are identical and this only ever separates hits
 * produced from DIFFERENT states.
 */
function isSameWording(a: MatchedTerm, b: MatchedTerm): boolean {
  return a.target === b.target && a.keepOriginal === b.keepOriginal && a.source === b.source
}

export async function executeBatchTranslation<TContext>(
  dataList: TranslateBatchData<TContext>[],
  promptResolver: PromptResolver<TContext>,
  signal?: AbortSignal,
  modelGuard?: SubtitleModelGuard,
  batchIdentity?: (key: string) => void,
): Promise<string[]> {
  const { langConfig, context, promptConfig, subtitlePromptConfig } = dataList[0]!
  const texts = dataList.map((d) => d.text)

  const batchText = prepareTranslationText(texts.join(`\n\n${BATCH_SEPARATOR}\n\n`))
  const glossaryTerms = mergeBatchGlossaryTerms(dataList)
  let resolver = snapshotPromptResolver(promptResolver, promptConfig, subtitlePromptConfig)
  let cacheKey: string | undefined
  // A cue hash describes one input, not the neighbouring cues or glossary union
  // the model sees. Persist only the complete subtitle batch under its actual
  // rendered prompt. A singleton (including fallback) has its own identity.
  if (subtitlePromptConfig) {
    const prompt = await resolver(LANG_CODE_TO_EN_NAME[langConfig.targetCode], batchText, {
      isBatch: true,
      context,
      glossaryTerms,
    })
    cacheKey = Sha256Hex(
      "subtitle-batch-prompt-v1",
      JSON.stringify(getLocalProviderConfig(dataList[0]!.provider)),
      langConfig.sourceCode,
      langConfig.targetCode,
      JSON.stringify(texts),
      prompt.systemPrompt,
      prompt.prompt,
    )
    batchIdentity?.(cacheKey)
    resolver = async () => prompt
    const cached = await db.translationCache.get(cacheKey)
    signal?.throwIfAborted()
    if (cached?.translation) {
      const parsed = parseBatchResult(cached.translation)
      if (parsed.length === texts.length && parsed.every((text, i) => text || !texts[i]!.trim())) {
        subtitleWorkRuntime.note("cache-hit")
        if (!cached.subtitleInputs)
          await db.translationCache.put({
            key: cached.key,
            translation: cached.translation,
            createdAt: cached.createdAt,
            subtitleInputs: texts,
          })
        return parsed
      }
    }
  }
  const result = await executeQueuedTranslation(batchText, langConfig, dataList[0]!, resolver, {
    isBatch: true,
    context,
    signal,

    glossaryTerms,
    modelGuard,
    maxOutputTokens: subtitlePromptConfig ? subtitleOutputLimit(batchText) : undefined,
  })
  const parsed = parseBatchResult(result)
  if (subtitlePromptConfig) subtitleWorkRuntime.note("batch-results", undefined, parsed.length)
  if (cacheKey) {
    signal?.throwIfAborted()
    // Let BatchQueue own count-mismatch retries, without spending the network
    // retry budget as well. Invalid responses must never enter the cache.
    if (parsed.length !== texts.length) return parsed
    if (parsed.some((text, i) => !text && texts[i]!.trim()))
      throw new Error("Empty subtitle translation")
    await db.translationCache.put({
      key: cacheKey,
      translation: result,
      subtitleInputs: texts,
      createdAt: new Date(),
    })
  }
  return parsed
}

function snapshotPromptResolver<TContext>(
  resolver: PromptResolver<TContext>,
  config?: Pick<Config["pageTranslation"], "customPromptsConfig">,
  subtitleConfig?: Pick<Config["videoSubtitles"], "customPromptsConfig">,
): PromptResolver<TContext> {
  if (subtitleConfig)
    return async (language, text, options) =>
      getSubtitlesTranslatePromptFromConfig(
        subtitleConfig,
        language,
        text,
        options as import("@/utils/prompts/translate").TranslatePromptOptions<SubtitlePromptContext>,
      )
  return config
    ? async (language, text, options) =>
        getTranslatePromptFromConfig(
          config,
          language,
          text,
          options as import("@/utils/prompts/translate").TranslatePromptOptions<WebPagePromptContext>,
        )
    : resolver
}

export type TranslateBatchData<TContext = unknown> = QueuedTranslationRouting & {
  work?: SubtitleWorkContext
  text: string
  langConfig: Config["language"]
  hash: string
  scheduleAt: number
  context?: TContext
  // Resolved by the sender, where the page URL is known. A separate field from
  // `context` on purpose: `context` is part of the batch key.
  glossaryTerms?: readonly MatchedTerm[]
  // Which revision `glossaryTerms` was read from — how `mergeBatchGlossaryTerms`
  // settles two members that disagree about one term.
  glossaryRevision?: number
  // Cancellation scope (`${tabId}:${sessionId}`); absent = uncancellable.
  scope?: string
  promptConfig?: Pick<Config["pageTranslation"], "customPromptsConfig">
  priority?: number
  subtitlePromptConfig?: Pick<Config["videoSubtitles"], "customPromptsConfig">
}

/**
 * Compose the cancellation scope from the message sender and the content
 * script's session id. Building it background-side from `sender.tab.id` makes
 * cross-tab cancellation impossible by construction.
 */
export function buildTranslationScopeKey(
  sender: { tab?: { id?: number } } | undefined,
  sessionId: string | undefined,
): string | undefined {
  const tabId = sender?.tab?.id
  return typeof tabId === "number" && sessionId ? `${tabId}:${sessionId}` : undefined
}

interface TranslationQueueSetupConfig<TContext = unknown> {
  promptResolver: PromptResolver<TContext>
  // Present only for queues whose requests carry cancellation scopes.
  isScopeCancelled?: (scopeKey: string) => boolean
  queueName: "webpage" | "subtitles"
}

async function createTranslationQueues<TContext>(config: TranslationQueueSetupConfig<TContext>) {
  await initializePerformance()
  const { promptResolver, isScopeCancelled, queueName } = config
  const performance = getPerformanceSnapshot()
  const batch = performance.batches[queueName === "webpage" ? "page" : "subtitles"]
  const { maxCharactersPerBatch, maxItemsPerBatch } = batch
  const requestQueue = new RequestQueue({
    timeoutMs: RESOURCE_DEFAULTS.timeoutMs,
    maxRetries: RESOURCE_DEFAULTS.maxAttempts - 1,
    baseRetryDelayMs: RESOURCE_DEFAULTS.baseRetryDelayMs,
    maxQueued: performance.global.maxQueued,
    consumer: queueName,
    onDeduplicate: () => subtitleWorkRuntime.note(`deduplicated:${queueName}`),
    onRetry: (delay, rateLimited) =>
      subtitleWorkRuntime.note(
        rateLimited ? `rate-limit-backoff-ms:${queueName}` : `retry-backoff-ms:${queueName}`,
        undefined,
        delay,
      ),
  })
  const batchQueue = new BatchQueue<
    TranslateBatchData<TContext>,
    string | { translation: string; batchKey: string; batchIndex: number }
  >({
    maxCharactersPerBatch:
      queueName === "subtitles"
        ? Math.min(maxCharactersPerBatch, SUBTITLE_WORK_LIMITS.sourceCharacters)
        : maxCharactersPerBatch,
    maxItemsPerBatch:
      queueName === "subtitles"
        ? Math.min(maxItemsPerBatch, SUBTITLE_WORK_LIMITS.cues)
        : maxItemsPerBatch,
    maxPending: batch.maxPending,
    batchDelay: batch.batchDelay,
    enableFallbackToIndividual: true,
    getBatchKey: (data) => {
      return Sha256Hex(
        `${data.langConfig.sourceCode}-${data.langConfig.targetCode}-${getQueuedProviderId(data.provider)}`,
        data.context ? JSON.stringify(data.context) : "",
        JSON.stringify(data.provider),
        JSON.stringify(data.promptConfig ?? null),
        JSON.stringify(data.subtitlePromptConfig ?? null),
        data.work ? `${data.work.start}:${data.work.end}` : "",

        // Not the terms — the REVISION. The terms differ per paragraph and
        // keying on them would end batching for glossary users; the revision is
        // one global counter that every paragraph of a page carries alike, so
        // this component is inert except across an edit. What it buys is that a
        // batch can only ever hold one glossary state, which is the only way to
        // represent a REMOVAL: see `mergeBatchGlossaryTerms`.
        `glossaryRevision:${data.glossaryRevision ?? 0}`,
      )
    },
    getCharacters: (data) => data.text.length,
    getDedupKey: (data) =>
      queueName === "subtitles"
        ? Sha256Hex(data.hash, `glossaryRevision:${data.glossaryRevision ?? 0}`)
        : data.hash,
    getScope: (data) => data.scope,
    isScopeCancelled,
    executeBatch: async (dataList, meta) => {
      // Stable for this RequestQueue task: automatic retries must reuse the

      // A BatchQueue retry/fallback invokes this adapter again and gets a new
      // key for that new real model call.

      const hash = Sha256Hex(...dataList.map((d) => d.hash))
      const earliestScheduleAt = Math.min(...dataList.map((d) => d.scheduleAt))
      const batchThunk = async (
        signal?: AbortSignal,
        liveScopes?: () => readonly string[] | undefined,
      ) => {
        let batchKey: string | undefined
        const results = await executeBatchTranslation(
          dataList,
          promptResolver,
          signal,
          queueName === "subtitles"
            ? subtitleWorkRuntime.guard(
                liveScopes ?? (() => meta.scopes),
                dataList.map((d) => d.hash),
                signal,
              )
            : undefined,
          (key) => {
            batchKey = key
          },
        )
        return results.map((translation, batchIndex) =>
          batchKey ? { translation, batchKey, batchIndex } : translation,
        )
      }

      return requestQueue.enqueue(batchThunk, earliestScheduleAt, hash, meta.scopes, {
        attempts: meta.attempts,
        priority: Math.min(...dataList.map((d) => d.priority ?? 1)),
      })
    },
    executeIndividual: async (data, meta) => {
      const { text, langConfig, hash, scheduleAt, context, glossaryTerms } = data
      // This individual fallback is its own model call, but any automatic
      // retries of its RequestQueue thunk reuse the same idempotency key.

      const thunk = async (
        signal?: AbortSignal,
        liveScopes?: () => readonly string[] | undefined,
      ) => {
        if (data.subtitlePromptConfig) {
          let batchKey = ""
          const results = await executeBatchTranslation(
            [data],
            promptResolver,
            signal,
            subtitleWorkRuntime.guard(liveScopes ?? (() => meta.scopes), [hash], signal),
            (key) => {
              batchKey = key
            },
          )
          if (results.length !== 1) throw new BatchCountMismatchError(1, results.length, results)
          return { translation: results[0]!, batchKey, batchIndex: 0 }
        }
        return executeQueuedTranslation(
          text,
          langConfig,
          data,
          snapshotPromptResolver(promptResolver, data.promptConfig, data.subtitlePromptConfig),
          {
            isBatch: data.promptConfig || data.subtitlePromptConfig ? true : undefined,
            context,
            signal,

            // The sender's own terms, NOT the batch union: this is one item again.
            // Dropping them here would let a batch that fell back translate
            // without the glossary and then cache that result under a hash taken
            // over a prompt that HAD the terms in it — a mismatch that outlives
            // the failure by a week.
            glossaryTerms,
          },
        )
      }
      return requestQueue.enqueue(thunk, scheduleAt, hash, meta.scopes, {
        priority: data.priority,
        attempts: meta.attempts,
      })
    },
    onError: (error, context) => {
      const errorType = context.isFallback ? "Individual request" : "Batch request"
      logger.error(
        `${errorType} failed (batchKey: ${context.batchKey}, retry: ${context.retryCount}):`,
        error.message,
      )
    },
  })

  return { requestQueue, batchQueue }
}

/** Complete legacy migration before reading sparse snapshots. */
async function prepareQueueConfiguration() {
  await ensureInitializedConfig()
  await initializePerformance()
}

/**
 * Re-apply queue config from storage on every persisted change. This replaces
 * the per-field set*QueueConfig messages: those could be dropped while the SW
 * was cold-starting (handlers used to register only after awaits), silently
 * leaving the live queue on stale values.
 */
function watchQueueConfig(
  queueName: "webpage" | "subtitles",
  queuesPromise: Promise<{
    requestQueue: RequestQueue
    batchQueue: { setBatchConfig: (config: Partial<BatchPerformance>) => void }
  }>,
) {
  watchPerformance(() => {
    void queuesPromise
      .then(({ requestQueue, batchQueue }) => {
        const snapshot = getPerformanceSnapshot()
        const batch = snapshot.batches[queueName === "webpage" ? "page" : "subtitles"]
        requestQueue.setQueueOptions({ maxQueued: snapshot.global.maxQueued })
        batchQueue.setBatchConfig(
          queueName === "subtitles"
            ? {
                ...batch,
                maxCharactersPerBatch: Math.min(
                  batch.maxCharactersPerBatch,
                  SUBTITLE_WORK_LIMITS.sourceCharacters,
                ),
                maxItemsPerBatch: Math.min(batch.maxItemsPerBatch, SUBTITLE_WORK_LIMITS.cues),
              }
            : batch,
        )
      })
      .catch(() => logger.error("Unable to update translation queue configuration"))
  })
}

export function createWebPageTranslationQueues() {
  // Scopes whose cancel already drained the queues. Consulted by (a) the
  // enqueue handler after its cache-lookup await and (b) the batch queue's
  // retry/fallback path after its backoff sleep — both are windows where a
  // request lives in NO cancellable structure, so a cancel arriving there
  // would otherwise be lost (#1881).
  const cancelledScopes = new CancelledScopeRegistry()

  const webPromptResolver: PromptResolver<WebPagePromptContext> = getTranslatePrompt

  const queuesPromise = prepareQueueConfiguration().then(() =>
    createTranslationQueues<WebPagePromptContext>({
      promptResolver: webPromptResolver,
      isScopeCancelled: (scopeKey) => cancelledScopes.has(scopeKey),
      queueName: "webpage",
    }),
  )

  watchQueueConfig("webpage", queuesPromise)

  return { queuesPromise, cancelledScopes }
}

/**
 * Create subtitle translation queues and watch their configuration
 */

export function createSubtitlesTranslationQueues() {
  const cancelledScopes = new CancelledScopeRegistry(10 * 60_000, 4096)
  const queuesPromise = prepareQueueConfiguration().then(() =>
    createTranslationQueues({
      promptResolver: getSubtitlesTranslatePrompt,
      isScopeCancelled: (scope) => cancelledScopes.has(scope),
      queueName: "subtitles",
    }),
  )

  watchQueueConfig("subtitles", queuesPromise)

  return { queuesPromise, cancelledScopes }
}
