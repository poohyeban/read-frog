import type { SubtitlesFetcher } from "../types"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import {
  TEXT_TRACK_CUE_POLL_INTERVAL_MS,
  TEXT_TRACK_CUE_WAIT_TIMEOUT_MS,
  TEXT_TRACK_NATIVE_REHIDE_DELAY_MS,
} from "@/utils/constants/subtitles"
import { Sha256Hex } from "@/utils/hash"
import { i18n } from "@/utils/i18n"
import { pollUntil } from "@/utils/poll"
import { NoSubtitlesError, OverlaySubtitlesError } from "@/utils/subtitles/errors"
import { cuesToFragments } from "./cues"

interface TextTrackFetcherOptions {
  resolveVideo: () => HTMLVideoElement | null
  getVideoId: () => string | null
  isSourceTrack?: (track: TextTrack) => boolean
}

const SUBTITLE_KINDS = new Set<TextTrackKind>(["subtitles", "captions"])

export class TextTrackFetcher implements SubtitlesFetcher {
  private generation = 0
  private trackIds = new WeakMap<TextTrack, number>()
  private nextTrackId = 0
  private subtitles: SubtitlesFragment[] = []
  private sourceLanguage = ""
  private cachedTrackHash: string | null = null
  private playerModes = new Map<TextTrack, TextTrackMode>()
  private rehideTimer: ReturnType<typeof setTimeout> | null = null
  private watchedTracks: TextTrackList | null = null
  // Only we set "hidden", so any other mode is what the player now wants restored.
  private readonly rehideOnTrackChange = () => {
    for (const track of Array.from(this.watchedTracks ?? [])) {
      if (track.mode !== "hidden") {
        this.playerModes.set(track, track.mode)
      }
    }
    this.hideShowingTracks()
  }

  constructor(private options: TextTrackFetcherOptions) {}

  async fetch(): Promise<SubtitlesFragment[]> {
    const video = this.options.resolveVideo()
    if (!video) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.videoNotFound"))
    }

    const track = this.selectTrack(video)
    if (!track) {
      throw new NoSubtitlesError()
    }

    const trackHash = this.buildTrackHash(track)
    if (this.subtitles.length > 0 && this.cachedTrackHash === trackHash) {
      return this.subtitles
    }

    this.ensureLoading(track)
    const generation = this.generation
    const fragments = cuesToFragments(await this.waitForCues(track, generation))
    if (generation !== this.generation) throw new DOMException("Aborted", "AbortError")
    if (fragments.length === 0) {
      throw new NoSubtitlesError()
    }

    this.subtitles = fragments
    this.sourceLanguage = track.language
    this.cachedTrackHash = this.buildTrackHash(track)

    return fragments
  }

  getSourceLanguage(): string {
    return this.sourceLanguage
  }

  async hasAvailableSubtitles(): Promise<boolean> {
    const video = this.options.resolveVideo()
    const track = video ? this.selectTrack(video) : null
    if (!track) {
      return false
    }

    this.ensureLoading(track)
    return true
  }

  async shouldUseSameTrack(): Promise<boolean> {
    if (this.subtitles.length === 0 || !this.cachedTrackHash) {
      return false
    }

    const video = this.options.resolveVideo()
    const track = video ? this.selectTrack(video) : null
    return !!track && this.buildTrackHash(track) === this.cachedTrackHash
  }

  hideNativeSubtitles(): void {
    this.hideShowingTracks()
    this.clearRehideTimer()
    this.rehideTimer = setTimeout(() => {
      this.rehideTimer = null
      this.hideShowingTracks()
    }, TEXT_TRACK_NATIVE_REHIDE_DELAY_MS)
    this.watchTrackChanges()
  }

  showNativeSubtitles(): void {
    // Before restoring, or putting a track back to "showing" re-triggers the watcher.
    this.unwatchTrackChanges()
    this.clearRehideTimer()
    for (const [track, mode] of this.playerModes) {
      track.mode = mode
    }
    this.playerModes.clear()
  }

  cleanup(): void {
    this.generation++
    this.showNativeSubtitles()
    this.subtitles = []
    this.sourceLanguage = ""
    this.cachedTrackHash = null
  }

  private buildTrackHash(track: TextTrack): string {
    let id = this.trackIds.get(track)
    if (id === undefined) this.trackIds.set(track, (id = ++this.nextTrackId))
    // Runs on source/track checks, never on timeupdate. Detect cue edits as well
    // as same-labelled replacement TextTrack objects.
    const content = Array.from(track.cues ?? []).map((cue) => [
      cue.startTime,
      cue.endTime,
      "text" in cue ? cue.text : "",
    ])
    return Sha256Hex(
      JSON.stringify([
        this.options.getVideoId(),
        id,
        track.language,
        track.label,
        track.kind,
        content,
      ]),
    )
  }

  private selectTrack(video: HTMLVideoElement): TextTrack | null {
    const { isSourceTrack } = this.options
    const candidates = Array.from(video.textTracks).filter(
      (track) => SUBTITLE_KINDS.has(track.kind) && (!isSourceTrack || isSourceTrack(track)),
    )
    return (
      candidates.find((track) => track.mode === "showing") ??
      candidates.find((track) => track.kind === "subtitles") ??
      candidates[0] ??
      null
    )
  }

  private setMode(track: TextTrack, mode: TextTrackMode): void {
    if (!this.playerModes.has(track)) {
      this.playerModes.set(track, track.mode)
    }
    track.mode = mode
  }

  private ensureLoading(track: TextTrack): void {
    if (track.mode === "disabled") {
      this.setMode(track, "hidden")
    }
  }

  private hideShowingTracks(): void {
    const video = this.options.resolveVideo()
    if (!video) {
      return
    }

    for (const track of Array.from(video.textTracks)) {
      if (track.mode === "showing") {
        this.setMode(track, "hidden")
      }
    }
  }

  // The player can reveal captions long after we hid them, so stay subscribed.
  private watchTrackChanges(): void {
    const tracks = this.options.resolveVideo()?.textTracks ?? null
    if (!tracks || tracks === this.watchedTracks) {
      return
    }

    this.unwatchTrackChanges()
    this.watchedTracks = tracks
    tracks.addEventListener("addtrack", this.rehideOnTrackChange)
    tracks.addEventListener("change", this.rehideOnTrackChange)
  }

  private unwatchTrackChanges(): void {
    this.watchedTracks?.removeEventListener("addtrack", this.rehideOnTrackChange)
    this.watchedTracks?.removeEventListener("change", this.rehideOnTrackChange)
    this.watchedTracks = null
  }

  private clearRehideTimer(): void {
    if (this.rehideTimer !== null) {
      clearTimeout(this.rehideTimer)
      this.rehideTimer = null
    }
  }

  private async waitForCues(track: TextTrack, generation: number): Promise<TextTrackCueList> {
    const cues = await pollUntil(
      () => {
        if (generation !== this.generation) throw new DOMException("Aborted", "AbortError")
        return track.cues?.length ? track.cues : null
      },
      {
        timeoutMs: TEXT_TRACK_CUE_WAIT_TIMEOUT_MS,
        intervalMs: TEXT_TRACK_CUE_POLL_INTERVAL_MS,
      },
    )
    if (!cues) {
      throw new NoSubtitlesError()
    }
    return cues
  }
}
