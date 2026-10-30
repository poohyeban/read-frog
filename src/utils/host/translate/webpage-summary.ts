import type { PageSession } from "./translation-session"
import type { CachedWebPageContext } from "./webpage-context"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { ARTICLE_SUMMARY_RULE_VERSION } from "@/utils/content/summary"
import { Sha256Hex } from "@/utils/hash"
import { sendMessage } from "@/utils/message"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"
import { ContextCoordinator } from "./context-coordinator"
import { getPageTranslationSession } from "./translation-session"

const summaries = new ContextCoordinator<string | null>(16)
export function releaseWebPageSummaries(): void {
  summaries.clear()
}

export async function getOrGenerateWebPageSummary(
  webPageContext: CachedWebPageContext | null,
  providerRef: PromptableProviderRef,
  enableAIContentAware: boolean,
  session: PageSession | null = getPageTranslationSession() ?? null,
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
    session?.id ?? "unscoped",
  )
  const summary = await summaries.get(
    key,
    async () =>
      await sendMessage("getOrGenerateWebPageSummary", {
        webTitle,
        webContent,
        providerRef,
        sessionId: session?.id,
      }),
    session?.signal,
  )

  return summary || null
}
