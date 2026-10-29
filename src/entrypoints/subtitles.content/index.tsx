import "@/utils/zod-config"
import { defineContentScript } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { initI18n } from "@/utils/i18n"
import { subtitlesContentScriptMatches } from "./content-script-matches"
import "@/utils/iconify/local-icons"

declare global {
  interface Window {
    __READ_FROG_SUBTITLES_INJECTED__?: boolean
  }
}

export default defineContentScript({
  matches: subtitlesContentScriptMatches,
  allFrames: true,
  cssInjectionMode: "manifest",
  async main(ctx) {
    if (window.__READ_FROG_SUBTITLES_INJECTED__ || ctx.isInvalid) return
    window.__READ_FROG_SUBTITLES_INJECTED__ = true
    ctx.onInvalidated(() => {
      window.__READ_FROG_SUBTITLES_INJECTED__ = false
    })

    try {
      const config = await getLocalConfig()
      if (ctx.isInvalid) return
      if (!config?.videoSubtitles?.enabled) {
        ctx.abort()
        return
      }
      await initI18n(config.uiLanguage)
      if (ctx.isInvalid) return
      const { bootstrapSubtitlesRuntime } = await import("./runtime")
      if (!ctx.isInvalid) bootstrapSubtitlesRuntime(ctx)
    } catch (error) {
      ctx.abort()
      if (!isExtensionContextInvalidatedError(error)) throw error
    }
  },
})
