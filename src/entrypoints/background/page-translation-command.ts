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
    // Reads share a generation. Only a write or document invalidation may
    // supersede a request; opening a second Popup must not cancel a valid write.
    const revision = enabled === undefined ? (revisions.get(tabId) ?? Symbol()) : Symbol()
    revisions.set(tabId, revision)
    const check = async () => {
      const tab = await browser.tabs.get(tabId)
      if (revisions.get(tabId) !== revision || tab.url !== url || tab.status === "loading")
        throw new Error("Page changed while confirming translation")
    }
    await check()
    if (enabled === false) {
      // Intent must survive a failed delivery so auto-detection cannot undo it.
      await setPageTranslationEnabled(tabId, false, url, true)
    }
    await check()
    const applied =
      enabled === undefined
        ? await sendMessage("getAppliedPageTranslationState", undefined, { tabId, frameId: 0 })
        : await sendMessage("applyPageTranslationCommand", { enabled, url }, { tabId, frameId: 0 })
    await check()
    if (!applied || applied.url !== url || (enabled !== undefined && applied.enabled !== enabled))
      throw new Error("Page manager did not confirm translation state")
    return applied
  }
  return { request, invalidate }
}
