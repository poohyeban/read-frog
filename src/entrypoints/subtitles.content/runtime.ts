import type { ContentScriptContext } from "#imports"
import { isExtensionContextAlive } from "@/utils/error/extension-context"
import { initNetflixSubtitles } from "./init-netflix-subtitles"
import { initXcomSubtitles } from "./init-xcom-subtitles"
import { initYoutubeSubtitles } from "./init-youtube-subtitles"

let hasBootstrappedSubtitlesRuntime = false

export function bootstrapSubtitlesRuntime(ctx: ContentScriptContext) {
  if (hasBootstrappedSubtitlesRuntime) {
    return
  }

  hasBootstrappedSubtitlesRuntime = true

  // Reloading an extension leaves old content scripts in existing tabs. Check
  // before video listeners run, so WXT can tear down the old overlay and restore
  // native captions instead of sending work through an invalid runtime.
  const checkContext = () => {
    if (!isExtensionContextAlive()) ctx.abort("Extension context invalidated")
  }
  ctx.addEventListener(document, "timeupdate", checkContext, { capture: true })
  ctx.addEventListener(document, "visibilitychange", checkContext, { capture: true })

  initYoutubeSubtitles(ctx)
  initXcomSubtitles(ctx)
  initNetflixSubtitles(ctx)
}
