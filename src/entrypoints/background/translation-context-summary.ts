import type { ProviderRequestRouting } from "@/types/provider-request"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { RequestQueue } from "@/utils/request/request-queue"
import { generateArticleSummary } from "@/utils/content/summary"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { logger } from "@/utils/logger"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"
import { generateTextForProviderRef } from "./background-stream"

export async function getOrGenerateTranslationContextSummary(
  args: ProviderRequestRouting<PromptableProviderRef> & {
    title: string
    textContent: string
    cacheKeyParts: string[]
    requestQueue: RequestQueue
  },
): Promise<string | null> {
  const { title, textContent, providerRef, cacheKeyParts, requestQueue } = args

  const routing: ProviderRequestRouting<PromptableProviderRef> = { providerRef: args.providerRef }
  const preparedText = cleanText(textContent)
  if (!preparedText) {
    return null
  }

  const cacheKey = Sha256Hex(...cacheKeyParts, getProviderCacheIdentity(providerRef))

  const cached = await db.articleSummaryCache.get(cacheKey)
  if (cached) {
    logger.info("Using cached summary")
    return cached.summary
  }

  // Stable for this queue task, mirroring the translation batches: automatic
  // RequestQueue retries must reuse the idempotency key because the first

  const thunk = async (signal?: AbortSignal) => {
    const cachedAgain = await db.articleSummaryCache.get(cacheKey)
    if (cachedAgain) {
      return cachedAgain.summary
    }

    const summary = await generateArticleSummary(title, textContent, routing, {
      signal,
      generate: (payload, runOptions) => generateTextForProviderRef({ ...payload }, runOptions),
    })
    if (!summary) {
      return ""
    }

    await db.articleSummaryCache.put({
      key: cacheKey,
      summary,
      createdAt: new Date(),
    })

    logger.info("Generated and cached new summary")
    return summary
  }

  try {
    const summary = await requestQueue.enqueue(thunk, Date.now(), cacheKey)
    return summary || null
  } catch {
    logger.warn("Failed to get/generate summary:")
    return null
  }
}
