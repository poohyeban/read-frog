import type { PageSession } from "./translation-session"
import type { CachedWebPageContext } from "./webpage-context"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { ARTICLE_SUMMARY_RULE_VERSION } from "@/utils/content/summary"
import { Sha256Hex } from "@/utils/hash"
import { sendMessage } from "@/utils/message"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"
import { ContextCoordinator } from "./context-coordinator"
import { getPageTranslationSession } from "./translation-session"
import { getDocumentContextSignal, getWebPageContextSignal } from "./webpage-context"

const summaries = new ContextCoordinator<string | null>(16)
export function releaseWebPageSummaries(): void {
  summaries.clear()
}

export async function getOrGenerateWebPageSummary(
  webPageContext: CachedWebPageContext | null,
  providerRef: PromptableProviderRef,
  enableAIContentAware: boolean,
  session: Pick<PageSession, "id" | "signal"> | null = getPageTranslationSession() ?? null,
): Promise<string | null> {
  if (!enableAIContentAware || !webPageContext) {
    return null
  }

  const { webTitle, webContent } = webPageContext
  if (!webTitle.trim() || !webContent.trim()) {
    return null
  }

  const key = Sha256Hex(
    ARTICLE_SUMMARY_RULE_VERSION,
    webTitle,
    webContent,
    getProviderCacheIdentity(providerRef),
  )
  const signals = [
    getDocumentContextSignal(),
    session?.signal,
    getWebPageContextSignal(webPageContext),
  ].filter((signal): signal is AbortSignal => !!signal)
  const summary = await summaries.get(
    key,
    async (signal) => {
      // The shared network task owns its scope, not any individual feature.
      const scopeId = `context-${crypto.randomUUID()}`
      const cancel = () => {
        void sendMessage("cancelPageTranslationRequests", { sessionId: scopeId }).catch(() => {})
      }
      signal.addEventListener("abort", cancel, { once: true })
      try {
        signal.throwIfAborted()
        return await sendMessage("getOrGenerateWebPageSummary", {
          webTitle,
          webContent,
          providerRef,
          sessionId: scopeId,
        })
      } finally {
        signal.removeEventListener("abort", cancel)
      }
    },
    AbortSignal.any(signals),
  )

  return summary || null
}
