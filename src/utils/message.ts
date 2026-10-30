import type {
  BackgroundGenerateTextPayload,
  BackgroundGenerateTextResponse,
} from "@/types/background-generate-text"
import type { Config } from "@/types/config/config"
import type { ProviderRequestRouting } from "@/types/provider-request"
import type { SubtitleRequestPayload } from "@/types/subtitle-request"
import type { TranslationRequestPayload } from "@/types/translation-request"
import type {
  TTSPlaybackStartRequest,
  TTSPlaybackStartResponse,
  TTSPlaybackStopRequest,
} from "@/types/tts-playback"
import type { GlossarySnapshot } from "@/utils/glossary/active-matcher"
import type { LangCodeISO6393 } from "@/utils/languages"
import type { SpeechAudio } from "@/utils/providers/audio/types"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { SubtitleWireResult } from "@/utils/subtitles/result"
import { defineExtensionMessaging } from "@webext-core/messaging"

interface ProtocolMap {
  synthesizeSpeech: (data: {
    requestId: string
    text: string
    voice: string
    configHash: string
  }) => Promise<SpeechAudio>
  cancelSpeech: (data: { requestId: string }) => Promise<void>
  ttsPlaybackPrepare: () => Promise<{ ok: true }>
  ttsPlaybackStart: (data: TTSPlaybackStartRequest) => Promise<TTSPlaybackStartResponse>
  ttsPlaybackStop: (data: TTSPlaybackStopRequest) => Promise<{ ok: true }>
  ttsOffscreenPlay: (data: TTSPlaybackStartRequest) => Promise<TTSPlaybackStartResponse>
  ttsOffscreenStop: (data: TTSPlaybackStopRequest) => Promise<{ ok: true }>

  clearAiSegmentationCache: () => Promise<void>
  enqueueSubtitlesTranslateRequest: (data: SubtitleRequestPayload) => Promise<SubtitleWireResult>
  cancelSubtitleRequests: (data: { sessionId: string }) => void
  getSubtitlesSummary: (data: {
    videoTitle: string
    subtitlesContext: string
    sessionId?: string
    priority?: number
    providerRef: PromptableProviderRef
  }) => Promise<string | null>
  getCachedVideoSummary: (data: {
    transcript: string
    targetLanguage: string
    providerRef: PromptableProviderRef
  }) => Promise<string | null>
  saveVideoSummary: (data: {
    transcript: string
    targetLanguage: string
    providerRef: PromptableProviderRef
    summary: string
  }) => Promise<void>
  aiSegmentSubtitles: (data: {
    jsonContent: string
    sessionId?: string
    priority?: number
    providerRef: PromptableProviderRef
  }) => Promise<string>
  getGlossarySnapshot: (data: {
    url: string | undefined
    targetLang: LangCodeISO6393
  }) => Promise<GlossarySnapshot>
  openPage: (data: { url: string; active?: boolean }) => void
  openOptionsPage: (data?: { route?: `/${string}` }) => void

  getInitialConfig: () => Config | null

  getEnablePageTranslationByTabId: (data: { tabId: number }) => boolean | undefined
  getAppliedPageTranslationStateByTabId: (data: {
    tabId: number
    url: string
  }) => Promise<{ enabled: boolean; url: string }>
  applyPageTranslationCommandByTabId: (data: {
    tabId: number
    url: string
    enabled: boolean
  }) => Promise<{ enabled: boolean; url: string }>
  getAppliedPageTranslationState: () => { enabled: boolean; url: string }
  applyPageTranslationCommand: (data: {
    url: string
    enabled: boolean
  }) => Promise<{ enabled: boolean; url: string }>
  getEnablePageTranslationFromContentScript: () => Promise<boolean>
  tryToSetEnablePageTranslationByTabId: (data: { tabId: number; enabled: boolean }) => void
  tryToSetEnablePageTranslationOnContentScript: (data: { enabled: boolean }) => void
  setAndNotifyPageTranslationStateChangedByManager: (data: {
    enabled: boolean
    url?: string
    userInitiated?: boolean
  }) => void
  notifyTranslationStateChanged: (data: { enabled: boolean }) => void
  ensureIframeHostContentInjected: (data: { tabId?: number }) => void
  injectCurrentIframesAfterTopFrameNodeTranslation: () => void
  activateSameOriginIframeSelectionRuntime: () => boolean
  reportDetectedPageLanguage: (data: {
    detectedCodeOrUnd: LangCodeISO6393 | "und"
    url: string
  }) => void
  refreshDetectedPageLanguage: () => void
  getDetectedCode: () => LangCodeISO6393
  detectedPageLanguageChanged: (data: { detectedCode: LangCodeISO6393 }) => void
  askManagerToTogglePageTranslation: (data: { enabled: boolean }) => void
  openSelectionTranslationFromContextMenu: (data: { selectionText: string }) => void
  openSelectionCustomActionFromContextMenu: (data: {
    actionId: string
    selectionText: string
  }) => void

  enqueueTranslateRequest: (data: TranslationRequestPayload) => Promise<string>
  cancelPageTranslationRequests: (data: { sessionId: string }) => void
  getOrGenerateWebPageSummary: (
    data: ProviderRequestRouting<PromptableProviderRef> & {
      webTitle: string
      webContent: string
      sessionId?: string
    },
  ) => Promise<string | null>

  backgroundGenerateText: (
    data: BackgroundGenerateTextPayload,
  ) => Promise<BackgroundGenerateTextResponse>

  clearAllTranslationRelatedCache: () => Promise<void>
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>()
