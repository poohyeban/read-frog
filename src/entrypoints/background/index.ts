import "@/utils/zod-config"
import type { Config, UiLanguage } from "@/types/config/config"
import { browser, defineBackground } from "#imports"
import { storageAdapter } from "@/utils/config/storage-adapter"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { initI18n, setUiLanguage } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { openOptionsPage } from "@/utils/navigation"
import { runAiSegmentSubtitles } from "./ai-segmentation"
import { dispatchBackgroundStreamPort } from "./background-stream"
import { initializeActionIcons, registerActionIconListeners } from "./browser-action-icon"
import { ensureInitializedConfig } from "./config"
import { initializeContextMenu, registerContextMenuListeners } from "./context-menu"
import { cleanupAllAiSegmentationCache } from "./db-cleanup"
import {
  cleanupAllSummaryCache,
  cleanupAllTranslationCache,
  setUpDatabaseCleanup,
} from "./db-cleanup"
import { setupGlossaryMessageHandlers } from "./glossary"
import { setupIframeInjection } from "./iframe-injection"
import { setupLLMGenerateTextMessageHandlers } from "./llm-generate-text"
import { setupPageTranslationHandlers } from "./page-translation"
import { setupSpeechHandlers } from "./speech"
import { setupSubtitlesTranslationHandlers } from "./subtitles-translation"
import { translationMessage } from "./translation-signal"
import { setupTTSPlaybackMessageHandlers } from "./tts-playback"
import { setupVideoSummaryHandlers } from "./video-summary"

export default defineBackground({
  type: "module",
  main: () => {
    logger.info("Hello background!", { id: browser.runtime.id })

    browser.runtime.onInstalled.addListener(async () => {
      await ensureInitializedConfig()
    })

    onMessage("openPage", async (message) => {
      const { url, active } = message.data
      logger.info("openPage", { url, active })
      await browser.tabs.create({ url, active: active ?? true })
    })

    onMessage("openOptionsPage", async (message) => {
      logger.info("openOptionsPage", message.data)
      await openOptionsPage(message.data)
    })

    browser.runtime.onConnect.addListener((port) => {
      dispatchBackgroundStreamPort(port)
    })

    onMessage("clearAiSegmentationCache", cleanupAllAiSegmentationCache)
    onMessage("clearAllTranslationRelatedCache", async () => {
      await cleanupAllTranslationCache()
      await cleanupAllSummaryCache()
      await cleanupAllAiSegmentationCache()
    })

    translationMessage()
    registerActionIconListeners()

    // Register context menu listeners synchronously
    // This ensures listeners are registered before Chrome completes initialization
    registerContextMenuListeners()

    // Initialize action icons asynchronously
    void initializeActionIcons()

    // Synchronous: all translation and summary handlers register in the first turn of
    // the SW so wake-triggering messages are never dropped during init.
    setupPageTranslationHandlers()
    setupGlossaryMessageHandlers()
    setupSubtitlesTranslationHandlers()
    setupVideoSummaryHandlers()
    setupTTSPlaybackMessageHandlers()
    setupSpeechHandlers()
    onMessage("aiSegmentSubtitles", (message) => runAiSegmentSubtitles(message.data))

    void setUpDatabaseCleanup()

    // Start config and i18n initialization without delaying synchronous listener
    // registration. Consumers that materialize localized config-derived data await
    // this shared barrier before reading it.
    let currentUiLanguage: UiLanguage | undefined
    const backgroundReady = (async () => {
      const config = await ensureInitializedConfig()
      currentUiLanguage = config?.uiLanguage ?? "auto"
      await initI18n(currentUiLanguage)
    })()

    setupLLMGenerateTextMessageHandlers()

    // Setup on-demand iframe injection after page translation is enabled.
    setupIframeInjection()

    // i18n bootstrap for the non-React background context. Runs after the synchronous
    // listener registration above (MV3 requires listeners before the first await). The

    // so they must be created AFTER initI18n or they freeze in the wrong language.
    void (async () => {
      await backgroundReady
      void initializeContextMenu()
    })()

    // Keep background-resolved strings in the selected language when it changes.
    // The context menu re-creates itself via its own config watcher
    // (registerContextMenuListeners), so here we only drive the i18next singleton and

    storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, (newConfig) => {
      void (async () => {
        await backgroundReady
        if (newConfig.uiLanguage === currentUiLanguage) return
        currentUiLanguage = newConfig.uiLanguage
        await setUiLanguage(newConfig.uiLanguage)
      })()
    })
  },
})
