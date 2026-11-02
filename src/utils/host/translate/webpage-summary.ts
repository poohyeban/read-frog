import type { PageSession } from "./translation-session"
import type { CachedWebPageContext } from "./webpage-context"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { ARTICLE_SUMMARY_RULE_VERSION } from "@/utils/content/summary"
import { Sha256Hex } from "@/utils/hash"
import { sendMessage } from "@/utils/message"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"
import { ContextCoordinator } from "./context-coordinator"
import { assertPromptContextCurrent } from "./context/prompt-guard"
import { requireSummaryAdmission } from "./context/summary-policy"
import { getDocumentContextSignal } from "./webpage-context"

const summaries = new ContextCoordinator<string | null>(16)
export function releaseWebPageSummaries(): void {
  summaries.clear()
}

export async function getOrGenerateWebPageSummary(
  webPageContext: CachedWebPageContext | null,
  providerRef: PromptableProviderRef,
  enableAIContentAware: boolean,
  session: Pick<PageSession, "id" | "signal"> | null = null,
  options: { requireModel?: boolean } = {},
): Promise<string | null> {
  if (!enableAIContentAware || !webPageContext) {
    return null
  }

  // A complete short source is a deterministic context representation; never
  // fan out a summary model over each feed item just to shorten a few lines.
  if (
    !options.requireModel &&
    webPageContext.scopeType &&
    webPageContext.scopeType !== "Document" &&
    !webPageContext.provenance?.truncated
  )
    return webPageContext.webContent || null
  const { webContent } = webPageContext
  const webTitle =
    webPageContext.webTitle || (webPageContext.scopeType ? "Local source context" : "")
  if (!webTitle.trim() || !webContent.trim()) {
    return null
  }

  const key = Sha256Hex(
    ARTICLE_SUMMARY_RULE_VERSION,
    webTitle,
    webContent,
    getProviderCacheIdentity(providerRef),
  )
  if (webPageContext.scopeType) requireSummaryAdmission(key)
  const signals = [getDocumentContextSignal(), session?.signal].filter(
    (signal): signal is AbortSignal => !!signal,
  )
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
        assertPromptContextCurrent(webPageContext)
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
