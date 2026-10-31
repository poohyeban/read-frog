import type { ViewId } from "./ui/subtitles-settings-panel/views"
import type { SectionId } from "./ui/subtitles-sidebar/sections"
import type { SubtitlesSource } from "@/utils/constants/subtitles"
import type { LangCodeISO6393 } from "@/utils/languages"
import type { StateData, SubtitlesFragment, SubtitlesState } from "@/utils/subtitles/types"
import { atom, createStore } from "jotai"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { DEFAULT_SUBTITLE_POSITION, SUBTITLES_SOURCE } from "@/utils/constants/subtitles"
import { getCueTimeline } from "@/utils/subtitles/cue-timeline"
import { hasRenderableSubtitleByMode, isAwaitingTranslation } from "@/utils/subtitles/display-rules"
import { ROOT_VIEW } from "./ui/subtitles-settings-panel/views"
import { DEFAULT_SECTION_ID } from "./ui/subtitles-sidebar/sections"

export const subtitlesStore = createStore()

export const currentTimeMsAtom = atom<number>(0)

/** Keys the summary; null pauses it while navigation clears the previous source. */
export const currentVideoIdAtom = atom<string | null>(null)

/**
 * True while the host player is playing an ad (e.g. YouTube mid-roll).
 * Suppresses overlay content so main-video captions are not shown over ads.
 * Does not change user toggle intent (`subtitlesVisibleAtom`).
 */
export const adPlayingAtom = atom<boolean>(false)

/** Scheduler’s current *translated* cue only (null when no translated cue covers now). */
export const currentSubtitleAtom = atom<SubtitlesFragment | null>(null)

export const sourceLanguageAtom = atom<LangCodeISO6393 | null>(null)

/** Immutable local baseline. Quality candidates never replace this source publication. */
export const sourceTrackAtom = atom<SubtitlesFragment[]>([])

/** The scheduler's translated cues, for consumers that need the whole track
 * rather than whichever one covers now. */
export const translatedTrackAtom = atom<SubtitlesFragment[]>([])

/**
 * Display cue: prefer a translated scheduler cue; otherwise fall back to the source track
 * at the current time (used for original / pending bilingual UI).
 */
export const displaySubtitleAtom = atom((get): SubtitlesFragment | null => {
  if (get(adPlayingAtom)) {
    return null
  }

  const timeMs = get(currentTimeMsAtom)
  const scheduled = get(currentSubtitleAtom)
  // Only prefer the scheduler cue when it still covers now (guards time/atom desync).
  if (scheduled && scheduled.start <= timeMs && scheduled.end > timeMs) {
    return scheduled
  }

  return getCueTimeline(get(sourceTrackAtom)).at(timeMs)
})

export const subtitlesStateAtom = atom<StateData | null>(null)

export const subtitlesVisibleAtom = atom<boolean>(false)
export const subtitleStopPhaseAtom = atom<"idle" | "stopping" | "stopped" | "failed">("idle")

export const subtitlesSourceAtom = atom<SubtitlesSource>(SUBTITLES_SOURCE.NATIVE)

export const subtitlesSettingsPanelOpenAtom = atom<boolean>(false)

export const subtitlesSettingsPanelViewAtom = atom<ViewId>(ROOT_VIEW)

export const subtitlesSidebarOpenAtom = atom<boolean>(false)

export const videoSummaryPartialAtom = atom<string>("")

export const subtitlesSidebarActiveSectionAtom = atom<SectionId>(DEFAULT_SECTION_ID)

export const TranslatedDownloadPhase = {
  Idle: "idle",
  Checking: "checking",
  Preparing: "preparing",
  Translating: "translating",
  Complete: "complete",
  Failed: "failed",
  Cancelled: "cancelled",
} as const

// eslint-disable-next-line ts/no-redeclare
export type TranslatedDownloadPhase =
  (typeof TranslatedDownloadPhase)[keyof typeof TranslatedDownloadPhase]

export const translatedSubtitlesDownloadStatusAtom = atom<{
  phase: TranslatedDownloadPhase
  progress: number | null
}>({
  phase: TranslatedDownloadPhase.Idle,
  progress: null,
})

export interface SubtitlePosition {
  percent: number
  anchor: "top" | "bottom"
}

export const subtitlesPositionAtom = atom<SubtitlePosition>({ ...DEFAULT_SUBTITLE_POSITION })

export const subtitlesDisplayAtom = atom((get) => {
  const subtitle = get(displaySubtitleAtom)
  const stateData = get(subtitlesStateAtom)
  const isVisible = get(subtitlesVisibleAtom)
  const { style } = get(configFieldsAtomMap.videoSubtitles)

  // translationOnly must never fall back to source-only original for "content".
  const failed =
    subtitle?.translationOutcome &&
    !["success", "empty"].includes(subtitle.translationOutcome.status)
  const readableSubtitle =
    failed && style.displayMode === "translationOnly" && !subtitle.translation
      ? { ...subtitle, translation: subtitle.text }
      : subtitle
  const contentSubtitle =
    style.displayMode === "translationOnly"
      ? readableSubtitle?.translation
        ? readableSubtitle
        : null
      : readableSubtitle

  return {
    subtitle: contentSubtitle,
    stateData,
    isVisible,
  }
})

export const subtitlesShowStateAtom = atom((get): Exclude<SubtitlesState, "idle"> | undefined => {
  if (get(adPlayingAtom)) return undefined

  const { subtitle, stateData } = get(subtitlesDisplayAtom)
  const { style } = get(configFieldsAtomMap.videoSubtitles)
  const hasRenderable = hasRenderableSubtitleByMode(subtitle, style.displayMode)
  const isError = stateData?.state === "error"

  if (isError) return "error"

  return isAwaitingTranslation(subtitle, stateData) && !hasRenderable ? "loading" : undefined
})

export const subtitlesShowContentAtom = atom((get): boolean => {
  if (get(adPlayingAtom)) return false

  const { subtitle, isVisible } = get(subtitlesDisplayAtom)
  const { style } = get(configFieldsAtomMap.videoSubtitles)

  if (!isVisible) return false

  return hasRenderableSubtitleByMode(subtitle, style.displayMode)
})
