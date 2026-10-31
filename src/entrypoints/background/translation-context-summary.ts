import type { ProviderRequestRouting } from "@/types/provider-request"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { RequestQueue } from "@/utils/request/request-queue"
import {
  ARTICLE_SUMMARY_RULE_VERSION,
  generateArticleSummary,
  isValidArticleSummary,
} from "@/utils/content/summary"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"
import {
  isTranslationCancelledError,
  TranslationCancelledError,
} from "@/utils/request/cancellation"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"
import { generateTextForProviderRef } from "./background-stream"
import { providerExecutionKey } from "./translation-queues"

// Queue retries run first. Only terminal failures enter this bounded, temporary
// cooldown; they are never written to the successful Dexie cache.
const failures = new WeakMap<RequestQueue, Map<string, { until: number; error: unknown }>>()

export async function getOrGenerateTranslationContextSummary(
  args: ProviderRequestRouting<PromptableProviderRef> & {
    title: string
    textContent: string
    cacheKeyParts: string[]
    requestQueue: RequestQueue
    scope?: string
    priority?: number
    isScopeCancelled?: (scope: string) => boolean
    modelGuard?: (
      scopes: () => readonly string[] | undefined,
      signal?: AbortSignal,
    ) => import("@/utils/subtitles/work-policy").SubtitleModelGuard
  },
): Promise<string | null> {
  const { title, textContent, providerRef, cacheKeyParts, requestQueue, scope } = args
  const assertCurrent = () => {
    if (scope && args.isScopeCancelled?.(scope)) throw new TranslationCancelledError(scope)
  }
  assertCurrent()
  if (!cleanText(textContent)) return null
  const cacheKey = Sha256Hex(
    ARTICLE_SUMMARY_RULE_VERSION,
    ...cacheKeyParts,
    getProviderCacheIdentity(providerRef),
  )
  let cooldowns = failures.get(requestQueue)
  if (!cooldowns) failures.set(requestQueue, (cooldowns = new Map()))
  const failure = cooldowns.get(cacheKey)
  if (failure && failure.until > Date.now()) throw failure.error
  cooldowns.delete(cacheKey)

  const cached = await db.articleSummaryCache.get(cacheKey)
  assertCurrent()
  if (cached && isValidArticleSummary(cached.summary)) return cached.summary

  const thunk = async (
    signal?: AbortSignal,
    liveScopes: () => readonly string[] | undefined = () => (scope ? [scope] : undefined),
  ) => {
    signal?.throwIfAborted()
    const cachedAgain = await db.articleSummaryCache.get(cacheKey)
    signal?.throwIfAborted()
    if (cachedAgain && isValidArticleSummary(cachedAgain.summary)) return cachedAgain.summary
    const summary = await generateArticleSummary(
      title,
      textContent,
      { providerRef },
      {
        signal,
        generate: (payload, options) =>
          generateTextForProviderRef(payload, {
            ...options,
            modelGuard: args.modelGuard?.(liveScopes, signal),
          }),
      },
    )
    signal?.throwIfAborted()
    if (!summary) return ""
    await db.articleSummaryCache.put({ key: cacheKey, summary, createdAt: new Date() })
    return summary
  }

  try {
    // Do not share an unscoped subscriber with scoped ones: it would pin their
    // task forever. Scoped subscribers still share across tabs and sessions.
    const taskKey = `${cacheKey}:${scope ? "scoped" : "unscoped"}`
    const summary = await requestQueue.enqueue(
      thunk,
      Date.now(),
      taskKey,
      scope ? [scope] : undefined,
      { priority: args.priority, providerKey: providerExecutionKey(providerRef) },
    )
    assertCurrent()
    return summary || null
  } catch (error) {
    assertCurrent()
    if (
      !isTranslationCancelledError(error) &&
      !(error instanceof Error && error.name === "AbortError")
    ) {
      const meta = getRequestErrorMeta(error)
      cooldowns.set(cacheKey, {
        until: Date.now() + Math.max(30_000, meta.retryAfterMs ?? 0),
        error,
      })
      while (cooldowns.size > 64) cooldowns.delete(cooldowns.keys().next().value!)
    }
    throw error
  }
}
