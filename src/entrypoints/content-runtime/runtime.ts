import "@/utils/zod-config"
import type { ContentRuntimePart } from "@/utils/content-runtime/parts"
import { ContentScriptContext } from "#imports"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { logger } from "@/utils/logger"
import { runHostContent } from "./host/main"
import { runSelectionContent } from "./selection/main"
import { runSideContent } from "./side/main"
import "@/utils/iconify/local-icons"

// Bundled once inside loader.js and injected by Chrome. Fetching this code as
// a web-accessible ES module lets the website's service worker intercept it.

const RUNNERS: Record<ContentRuntimePart, (ctx: ContentScriptContext) => Promise<void>> = {
  host: runHostContent,
  side: runSideContent,
  selection: runSelectionContent,
}

function isPartRunning(part: ContentRuntimePart) {
  if (part === "host") return window.__READ_FROG_HOST_INJECTED__ === true
  if (part === "selection") return window.__READ_FROG_SELECTION_INJECTED__ === true
  return false
}

export async function runContentParts(parts: readonly ContentRuntimePart[]) {
  await Promise.all(
    parts
      // A new context with a running part's name would invalidate it
      .filter((part) => !isPartRunning(part))
      .map(async (part) => {
        const ctx = new ContentScriptContext(part, { cssInjectionMode: "manual" })
        try {
          // Each part keeps the context name it had as its own content script,
          // so stopping old scripts and invalidation behave as before.
          if (!ctx.isInvalid) await RUNNERS[part](ctx)
        } catch (error) {
          ctx.abort()
          if (!isExtensionContextInvalidatedError(error)) {
            logger.error(`[content-runtime] "${part}" crashed on startup`, error)
          }
        }
      }),
  )
}
