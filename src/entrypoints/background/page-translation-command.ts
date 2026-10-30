import { browser } from "#imports"
import { sendMessage } from "@/utils/message"
import { setPageTranslationEnabled } from "./page-translation-state"

/** RPC confirmation is separate from persisted intent. Owns no engine lifecycle. */
export function createPageTranslationCommandBridge() {
  const revisions = new Map<number, symbol>()
  function invalidate(tabId: number) {
    revisions.delete(tabId)
  }
  async function request(data: { tabId: number; url: string; enabled?: boolean }) {
    const { tabId, url, enabled } = data
    const revision = Symbol()
    revisions.set(tabId, revision)
    const check = async () => {
      const tab = await browser.tabs.get(tabId)
      if (revisions.get(tabId) !== revision || tab.url !== url)
        throw new Error("Page changed while confirming translation")
    }
    try {
      await check()
      if (enabled === false) {
        // Intent must survive a failed delivery so auto-detection cannot undo it.
        await setPageTranslationEnabled(tabId, false, url, true)
      }
      await check()
      const applied =
        enabled === undefined
          ? await sendMessage("getAppliedPageTranslationState", undefined, { tabId, frameId: 0 })
          : await sendMessage(
              "applyPageTranslationCommand",
              { enabled, url },
              { tabId, frameId: 0 },
            )
      await check()
      if (!applied || applied.url !== url || (enabled !== undefined && applied.enabled !== enabled))
        throw new Error("Page manager did not confirm translation state")
      return applied
    } finally {
      if (revisions.get(tabId) === revision) revisions.delete(tabId)
    }
  }
  return { request, invalidate }
}
