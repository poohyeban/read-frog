import type { LangCodeISO6393 } from "@read-frog/definitions"
import type {
  BackgroundGenerateTextPayload,
  BackgroundGenerateTextResponse,
} from "@/types/background-generate-text"
import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { ProviderRequestRouting } from "@/types/provider-request"
import type { GlossarySnapshot } from "@/utils/glossary/active-matcher"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { defineExtensionMessaging } from "@webext-core/messaging"

interface ProtocolMap {
  clearAiSegmentationCache: () => Promise<void>
  enqueueSubtitlesTranslateRequest: (data: {
    text: string
    langConfig: Config["language"]
    providerRef: SerializableProviderRef
    scheduleAt: number
    hash: string
    webTitle?: string | null
    webDescription?: string | null
    summary?: string | null
    // See `enqueueTranslateRequest`.
    glossaryTerms?: MatchedTerm[]
    glossaryRevision?: number
  }) => Promise<string>
  getSubtitlesSummary: (data: {
    videoTitle: string
    subtitlesContext: string
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

  enqueueTranslateRequest: (
    data: ProviderRequestRouting & {
      glossaryTerms?: MatchedTerm[]
      glossaryRevision?: number
      text: string
      langConfig: Config["language"]
      scheduleAt: number
      hash: string
      textFormat?: TranslationTextFormat
      // Source line breaks are semantic (newline-preserving container or typed
      // input); providers whose transport collapses "\n" must protect them.
      preserveLineBreaks?: boolean
      webTitle?: string | null
      webDescription?: string | null
      webContent?: string | null
      webSummary?: string | null
      // Page-translation session this request belongs to; scopes the request
      // for cancelPageTranslationRequests. Absent for non-page requests
      // (input/selection translation), which are never cancellable.
      sessionId?: string
      forceRetranslation?: boolean

      // scoped elsewhere does not — the background serves every tab and cannot
      // tell them apart. Passing `[]` means "nothing matched"

      // requests resolved either side of an edit made while the page was still
      // translating; without this the background would settle a disagreement by
      // message arrival order
    },
  ) => Promise<string>
  cancelPageTranslationRequests: (data: { sessionId: string }) => void
  getOrGenerateWebPageSummary: (
    data: ProviderRequestRouting<PromptableProviderRef> & {
      webTitle: string
      webContent: string
    },
  ) => Promise<string | null>

  backgroundGenerateText: (
    data: BackgroundGenerateTextPayload,
  ) => Promise<BackgroundGenerateTextResponse>

  clearAllTranslationRelatedCache: () => Promise<void>
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>()
