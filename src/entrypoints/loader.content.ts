import type { Config } from "@/types/config/config"
import { browser, defineContentScript } from "#imports"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config-storage-key"
import { shouldSkipDocument } from "@/utils/content-runtime/page-guards"
import { takeRequestedParts } from "@/utils/content-runtime/parts"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { getEffectiveSiteControlUrl, isSiteEnabled } from "@/utils/site-control"

// A first look at site control, from the stored config as it is. Each part
// parses the config and checks again; this only spares a disabled site the
// runtime import, so anything unexpected lets the import go ahead.
async function isSiteEnabledByStoredConfig() {
  try {
    const { [CONFIG_STORAGE_KEY]: config } = await browser.storage.local.get(CONFIG_STORAGE_KEY)
    // Unparsed: a malformed one throws into the catch below
    return isSiteEnabled(
      getEffectiveSiteControlUrl(window.location.href),
      (config as Config | undefined) ?? null,
    )
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return false
    return true
  }
}

export default defineContentScript({
  matches: ["*://*/*", "file:///*"],
  async main(ctx) {
    const parts = takeRequestedParts(globalThis, window === window.top)

    if (parts.length === 0 || shouldSkipDocument(document)) return
    if (!(await isSiteEnabledByStoredConfig())) return

    try {
      if (ctx.isInvalid) return
      // WXT inlines this import into the injected IIFE. It defers module
      // initialization on disabled sites without requesting a script URL.
      const { runContentParts } = await import("./content-runtime/runtime")
      if (!ctx.isInvalid) await runContentParts(parts)
    } catch (error) {
      ctx.abort()
      if (!isExtensionContextInvalidatedError(error)) throw error
    }
  },
})
