import type { SubtitleTraceSink } from "@/utils/subtitles/diagnostics"
import type { StateData, SubtitlesFragment, SubtitlesState } from "@/utils/subtitles/types"
import { CueTimeline, cueIdentity } from "@/utils/subtitles/cue-timeline"
import {
  adPlayingAtom,
  currentSubtitleAtom,
  currentTimeMsAtom,
  subtitlesStateAtom,
  subtitlesStore,
  translatedTrackAtom,
  subtitlesVisibleAtom,
} from "./atoms"

const ERROR_STATE_AUTO_HIDE_MS = 5_000

/**
 * Holds only *translated* cues. Originals live on sourceTrackAtom; the UI falls back there.
 */
export class SubtitlesScheduler {
  private videoElement: HTMLVideoElement
  private timeline = new CueTimeline()
  private qualityTimeline = new CueTimeline()
  private trace?: SubtitleTraceSink
  setDiagnostics(trace?: SubtitleTraceSink) {
    this.trace = trace
  }
  private selected: SubtitlesFragment | null = null
  private get subtitles() {
    return this.timeline.cues
  }
  private currentIndex = -1
  private active = false
  private currentState: StateData = {
    state: "idle",
  }

  private errorAutoHideTimeoutId: ReturnType<typeof setTimeout> | null = null

  constructor({ videoElement }: { videoElement: HTMLVideoElement }) {
    this.videoElement = videoElement
    this.attachListeners()
  }

  start() {
    this.attachListeners()
    this.active = true
    // Sync immediately: timeupdate may not fire while paused / mid-video.
    this.updateSubtitles(this.videoElement.currentTime)
    this.updateVisibility()
  }

  /**
   * Upsert translated cues by start. New cues are inserted; existing cues get translation updates.
   */
  supplementSubtitles(subtitles: SubtitlesFragment[], lane: "fast" | "quality" = "fast") {
    subtitles = subtitles.filter(
      (c) =>
        c.translation !== undefined &&
        (!c.translationOutcome ||
          c.translationOutcome.status === "success" ||
          c.translationOutcome.status === "empty"),
    )
    if (subtitles.length === 0) {
      return
    }

    const previous = this.currentIndex >= 0 ? this.subtitles[this.currentIndex] : null
    if (lane === "quality") this.qualityTimeline = this.qualityTimeline.upsert(subtitles)
    else this.timeline = this.timeline.upsert(subtitles)
    this.publishTranslatedTrack()
    this.updateSubtitles(this.videoElement.currentTime)
    if (previous !== this.subtitles[this.currentIndex]) this.updateCurrentSubtitle()
  }

  /**
   * After AI recut of a window: drop overlapping translated cues, but re-attach translations
   * whose start+end+text still match a next fragment. Unchanged cues must not be wiped then
   * skipped forever (coordinator still has them in translatedStarts).
   */
  reconcileTranslatedCuesAfterRecut(
    windowStartMs: number,
    windowEndMs: number,
    nextFragments: SubtitlesFragment[],
  ) {
    const outside = this.subtitles.filter(
      (fragment) => fragment.end <= windowStartMs || fragment.start >= windowEndMs,
    )
    const overlapping = this.subtitles.filter(
      (fragment) => fragment.end > windowStartMs && fragment.start < windowEndMs,
    )

    const byIdentity = new Map(
      overlapping.map((fragment) => [cueIdentity(fragment), fragment] as const),
    )
    const preserved = nextFragments.flatMap((fragment) => {
      const previous = byIdentity.get(cueIdentity(fragment))
      if (previous?.translation === undefined) {
        return []
      }
      return [{ ...fragment, translation: previous.translation }]
    })

    const next = [...outside, ...preserved].sort((a, b) => a.start - b.start)
    const unchanged =
      next.length === this.subtitles.length &&
      next.every((fragment, index) => {
        const prev = this.subtitles[index]
        if (!prev) return false
        return (
          prev.start === fragment.start &&
          prev.end === fragment.end &&
          prev.text === fragment.text &&
          prev.translation === fragment.translation
        )
      })
    if (unchanged) {
      return
    }

    this.timeline = new CueTimeline(next)
    this.publishTranslatedTrack()
    // Force re-resolve: index alone may stay stale while the atom still holds a removed cue.
    this.currentIndex = -1
    this.updateSubtitles(this.videoElement.currentTime)
    this.updateCurrentSubtitle()
  }

  getVideoElement(): HTMLVideoElement {
    return this.videoElement
  }

  getState(): SubtitlesState {
    return this.currentState.state ?? "idle"
  }

  isActive(): boolean {
    return this.active
  }

  stop() {
    this.clearErrorAutoHide()
    this.active = false
    this.detachListeners()
    this.updateVisibility()
  }

  show() {
    this.active = true
    // Sync immediately: timeupdate may not fire while paused / mid-video.
    this.updateSubtitles(this.videoElement.currentTime)
    this.updateVisibility()
  }

  hide() {
    this.active = false
    this.updateVisibility()
  }

  /** Force a cue resolve from the live video clock (e.g. after an ad ends). */
  resyncFromVideo() {
    if (!this.active) return
    this.updateSubtitles(this.videoElement.currentTime)
  }

  setState(state: SubtitlesState, data?: Partial<Omit<StateData, "state">>) {
    this.clearErrorAutoHide()
    this.currentState = {
      state,
      message: data?.message,
    }
    this.updateState()

    if (state === "error") {
      this.errorAutoHideTimeoutId = setTimeout(() => {
        if (this.currentState.state === "error") {
          this.setState("idle")
        }
      }, ERROR_STATE_AUTO_HIDE_MS)
    }
  }

  reset() {
    this.setState("idle")
    this.timeline = new CueTimeline()
    this.qualityTimeline = new CueTimeline()
    this.selected = null
    this.publishTranslatedTrack()
    this.currentIndex = -1
    this.updateCurrentSubtitle()
  }

  private attachListeners() {
    this.videoElement.addEventListener("timeupdate", this.handleTimeUpdate)
    this.videoElement.addEventListener("seeking", this.handleSeeking)
    this.videoElement.addEventListener("playing", this.handleSeeking)
    this.videoElement.addEventListener("seeked", this.handleSeeking)
  }

  private detachListeners() {
    this.videoElement.removeEventListener("timeupdate", this.handleTimeUpdate)
    this.videoElement.removeEventListener("seeking", this.handleSeeking)
    this.videoElement.removeEventListener("playing", this.handleSeeking)
    this.videoElement.removeEventListener("seeked", this.handleSeeking)
  }

  private handleTimeUpdate = () => {
    this.updateSubtitles(this.videoElement.currentTime)
  }

  private handleSeeking = () => {
    this.updateSubtitles(this.videoElement.currentTime)
  }

  private updateSubtitles(currentTime: number) {
    const timeMs = currentTime * 1000
    // Published whether or not captions are showing: the transcript follows
    // playback even when the user never turned subtitle translation on. An ad
    // plays through the same element, so its clock is not the video's.
    if (!subtitlesStore.get(adPlayingAtom)) {
      subtitlesStore.set(currentTimeMsAtom, timeMs)
    }

    if (!this.active) {
      return
    }

    const newIndex = this.timeline.indexAt(timeMs)

    const selected = this.qualityTimeline.at(timeMs) ?? this.timeline.at(timeMs)
    if (selected !== this.selected) {
      this.trace?.({
        event: "selected",
        lane: this.qualityTimeline.at(timeMs) ? "quality" : "fast",
        mediaTimeMs: timeMs,
        value: selected ? 1 : 0,
      })
      this.selected = selected
      this.currentIndex = newIndex
      this.updateCurrentSubtitle()
    }
  }

  private publishTranslatedTrack() {
    subtitlesStore.set(translatedTrackAtom, [...this.qualityTimeline.cues, ...this.subtitles])
  }

  private updateCurrentSubtitle() {
    const currentSubtitle = this.selected
    subtitlesStore.set(currentSubtitleAtom, currentSubtitle)
  }

  private updateState() {
    const stateData = this.currentState.state !== "idle" ? this.currentState : null
    subtitlesStore.set(subtitlesStateAtom, stateData)
  }

  private clearErrorAutoHide() {
    if (this.errorAutoHideTimeoutId !== null) {
      clearTimeout(this.errorAutoHideTimeoutId)
      this.errorAutoHideTimeoutId = null
    }
  }

  private updateVisibility() {
    subtitlesStore.set(subtitlesVisibleAtom, this.active)
  }
}
