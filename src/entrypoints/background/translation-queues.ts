import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { BatchQueueConfig, RequestQueueConfig } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { ProviderRequestRouting } from "@/types/provider-request"
import type { PromptResolver } from "@/utils/host/translate/api/ai"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { storage } from "#imports"
import { isLLMProviderConfig } from "@/types/config/provider"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR, BATCH_SEPARATOR_LINE_PATTERN } from "@/utils/constants/prompt"
import {
  BATCH_TIMEOUT_BASE_MS,
  BATCH_TIMEOUT_PER_CHAR_MS,
  MAX_BATCH_TIMEOUT_MS,
} from "@/utils/constants/translate"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { logger } from "@/utils/logger"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { BatchQueue } from "@/utils/request/batch-queue"
import { CancelledScopeRegistry } from "@/utils/request/cancellation"
import { RequestQueue } from "@/utils/request/request-queue"
import { ensureInitializedConfig } from "./config"

type QueuedTranslationProvider = ProviderConfig | SerializableProviderRef

type QueuedTranslationRouting =
  | { provider: QueuedTranslationProvider }
  | {
      provider: ProviderConfig | Extract<SerializableProviderRef, { kind: "local" }>
    }

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

export async function executeBatchTranslation<TContext>(
  dataList: TranslateBatchData<TContext>[],
  promptResolver: PromptResolver<TContext>,
  signal?: AbortSignal,
): Promise<string[]> {
  const { langConfig, context } = dataList[0]!
  const texts = dataList.map((d) => d.text)

  const batchText = texts.join(`\n\n${BATCH_SEPARATOR}\n\n`)
  const result = await executeQueuedTranslation(
    batchText,
    langConfig,
    dataList[0]!,
    promptResolver,
    {
      isBatch: true,
      context,
      signal,
    },
  )
  return parseBatchResult(result)
}

export type TranslateBatchData<TContext = unknown> = QueuedTranslationRouting & {
  text: string
  langConfig: Config["language"]
  hash: string
  scheduleAt: number
  context?: TContext
  // Resolved by the sender

  // settles two members that disagree about one term.

  // Cancellation scope (`${tabId}:${sessionId}`); absent = uncancellable.
  scope?: string
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
  requestQueueConfig: RequestQueueConfig
  batchQueueConfig: BatchQueueConfig
  promptResolver: PromptResolver<TContext>
  // Present only for queues whose requests carry cancellation scopes.
  isScopeCancelled?: (scopeKey: string) => boolean
  queueName: "webpage" | "subtitles"
  // "default" means the user's stored config could not be loaded — the queue
  // is running on DEFAULT_CONFIG values (rate 8 / capacity 20), NOT what the
  // options page shows. Logged loudly so support reports are diagnosable.
  configSource: "user" | "default"
}

async function createTranslationQueues<TContext>(config: TranslationQueueSetupConfig<TContext>) {
  const { rate, capacity } = config.requestQueueConfig
  const { maxCharactersPerBatch, maxItemsPerBatch } = config.batchQueueConfig
  const { promptResolver, isScopeCancelled, queueName, configSource } = config

  logger.info(`[translation-queues] ${queueName} queue init`, {
    rate,
    capacity,
    maxCharactersPerBatch,
    maxItemsPerBatch,
    configSource,
  })
  if (configSource === "default") {
    logger.error(
      `[translation-queues] ${queueName} queue running on DEFAULT config (rate ${rate}, capacity ${capacity}) — user config unavailable at init`,
    )
  }

  const requestQueue = new RequestQueue({
    rate,
    capacity,
    timeoutMs: 20_000,
    maxRetries: 2,
    baseRetryDelayMs: 1_000,
  })
  const batchQueue = new BatchQueue<TranslateBatchData<TContext>, string>({
    maxCharactersPerBatch,
    maxItemsPerBatch,
    batchDelay: 100,
    maxRetries: 3,
    enableFallbackToIndividual: true,
    // Narrow port, not the whole queue: while the rate limiter has no free
    // slot, pending batches keep filling to maxItems/maxChars instead of
    // flushing tiny every batchDelay (they'd only freeze in the queue).
    dispatchGate: { nextDispatchEtaMs: () => requestQueue.nextDispatchEtaMs() },
    getBatchKey: (data) => {
      return Sha256Hex(
        `${data.langConfig.sourceCode}-${data.langConfig.targetCode}-${getQueuedProviderId(data.provider)}`,
        data.context ? JSON.stringify(data.context) : "",
        // Not the terms — the REVISION. The terms differ per paragraph and

        // one global counter that every paragraph of a page carries alike, so
        // this component is inert except across an edit. What it buys is that a
      )
    },
    getCharacters: (data) => data.text.length,
    getDedupKey: (data) => data.hash,
    getScope: (data) => data.scope,
    isScopeCancelled,
    executeBatch: async (dataList, meta) => {
      // Stable for this RequestQueue task: automatic retries must reuse the

      // A BatchQueue retry/fallback invokes this adapter again and gets a new
      // key for that new real model call.
      const hash = Sha256Hex(...dataList.map((d) => d.hash))
      const earliestScheduleAt = Math.min(...dataList.map((d) => d.scheduleAt))
      const totalCharacters = dataList.reduce((sum, d) => sum + d.text.length, 0)
      const timeoutMs = Math.min(
        BATCH_TIMEOUT_BASE_MS + totalCharacters * BATCH_TIMEOUT_PER_CHAR_MS,
        MAX_BATCH_TIMEOUT_MS,
      )

      const batchThunk = async (signal?: AbortSignal): Promise<string[]> => {
        return await executeBatchTranslation(dataList, promptResolver, signal)
      }

      return requestQueue.enqueue(batchThunk, earliestScheduleAt, hash, meta.scopes, { timeoutMs })
    },
    executeIndividual: async (data) => {
      const { text, langConfig, hash, scheduleAt, context, scope } = data
      // This individual fallback is its own model call, but any automatic
      // retries of its RequestQueue thunk reuse the same idempotency key.
      const thunk = async (signal?: AbortSignal) => {
        return executeQueuedTranslation(text, langConfig, data, promptResolver, {
          context,
          signal,
          // The sender's own terms, NOT the batch union: this is one item again.
          // Dropping them here would let a batch that fell back translate

          // over a prompt that HAD the terms in it — a mismatch that outlives
          // the failure by a week.
        })
      }
      return requestQueue.enqueue(thunk, scheduleAt, hash, scope ? [scope] : undefined)
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

/**
 * Load the persisted config and build the queues. Never rejects: a broken
 * storage layer degrades to DEFAULT_CONFIG (loudly logged) instead of leaving
 * every translation message rejected.
 */
async function loadQueueSetupConfig(
  queueName: "webpage" | "subtitles",
  selectConfig: (config: Config) => {
    requestQueueConfig: RequestQueueConfig
    batchQueueConfig: BatchQueueConfig
  },
): Promise<{
  requestQueueConfig: RequestQueueConfig
  batchQueueConfig: BatchQueueConfig
  configSource: "user" | "default"
}> {
  let config: Config | null = null
  try {
    config = await ensureInitializedConfig()
  } catch {
    logger.error(`[translation-queues] failed to load config for ${queueName} queue`)
  }
  return {
    ...selectConfig(config ?? DEFAULT_CONFIG),
    configSource: config ? "user" : "default",
  }
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
    batchQueue: { setBatchConfig: (config: Partial<BatchQueueConfig>) => void }
  }>,
  selectConfig: (config: Config) => {
    requestQueueConfig: RequestQueueConfig
    batchQueueConfig: BatchQueueConfig
  },
) {
  let lastAppliedJson: string | null = null
  storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (newConfig) => {
    if (!newConfig) return
    void queuesPromise.then(({ requestQueue, batchQueue }) => {
      try {
        const selected = selectConfig(newConfig)
        const json = JSON.stringify(selected)
        if (json === lastAppliedJson) return
        requestQueue.setQueueOptions(selected.requestQueueConfig)
        batchQueue.setBatchConfig(selected.batchQueueConfig)
        lastAppliedJson = json
        logger.info(`[translation-queues] ${queueName} queue config updated`, selected)
      } catch {
        logger.error(`[translation-queues] failed to apply ${queueName} queue config change`)
      }
    })
  })
}

const selectWebPageQueueConfig = (config: Config) => ({
  requestQueueConfig: config.pageTranslation.requestQueueConfig,
  batchQueueConfig: config.pageTranslation.batchQueueConfig,
})

export function createWebPageTranslationQueues() {
  // Scopes whose cancel already drained the queues. Consulted by (a) the
  // enqueue handler after its cache-lookup await and (b) the batch queue's
  // retry/fallback path after its backoff sleep — both are windows where a
  // request lives in NO cancellable structure, so a cancel arriving there
  // would otherwise be lost (#1881).
  const cancelledScopes = new CancelledScopeRegistry()

  const webPromptResolver: PromptResolver<WebPagePromptContext> = getTranslatePrompt

  const queuesPromise = loadQueueSetupConfig("webpage", selectWebPageQueueConfig).then(
    ({ requestQueueConfig, batchQueueConfig, configSource }) =>
      createTranslationQueues<WebPagePromptContext>({
        requestQueueConfig,
        batchQueueConfig,
        promptResolver: webPromptResolver,
        isScopeCancelled: (scopeKey) => cancelledScopes.has(scopeKey),
        queueName: "webpage",
        configSource,
      }),
  )

  watchQueueConfig("webpage", queuesPromise, selectWebPageQueueConfig)

  return { queuesPromise, cancelledScopes }
}
