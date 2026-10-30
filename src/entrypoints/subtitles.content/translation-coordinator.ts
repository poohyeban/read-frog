import type { SegmentationPipeline } from "./segmentation-pipeline"
import type { Config } from "@/types/config/config"
import type { SubtitlesVideoContext } from "@/utils/subtitles/processor/translator"
import type { SubtitlesFragment, SubtitlesState } from "@/utils/subtitles/types"
import { getLocalConfig } from "@/utils/config/storage"
import { TRANSLATE_LOOK_AHEAD_MS, TRANSLATION_BATCH_SIZE } from "@/utils/constants/subtitles"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { cueIdentity, getCueTimeline } from "@/utils/subtitles/cue-timeline"
import { effectiveLookAheadMs } from "@/utils/subtitles/lookahead"
import { translateSubtitles } from "@/utils/subtitles/processor/translator"
import { subtitleFailure, type SubtitleOutcome } from "@/utils/subtitles/result"
import { SubtitleSession, type SubtitleTask } from "@/utils/subtitles/session"
import { adPlayingAtom, subtitlesStore } from "./atoms"

export interface TranslationCoordinatorOptions {
  session?: SubtitleSession
  configSnapshot?: Config
  getFragments: () => SubtitlesFragment[]
  getVideoElement: () => HTMLVideoElement | null
  getCurrentState: () => SubtitlesState
  segmentationPipeline: SegmentationPipeline | null
  onTranslated: (fragments: SubtitlesFragment[]) => void
  onStateChange: (state: SubtitlesState, data?: Record<string, string>) => void
}
interface PendingBatch {
  task: SubtitleTask
  cues: SubtitlesFragment[]
}
const EVENTS = [
  "loadedmetadata",
  "loadeddata",
  "seeking",
  "seeked",
  "playing",
  "timeupdate",
  "ratechange",
] as const
const MAX_PENDING_BATCHES = 2

/** Local admission is bounded; network concurrency/rate limits belong to RequestQueue. */
export class TranslationCoordinator {
  private session: SubtitleSession
  private active = false
  private video: HTMLVideoElement | null = null
  private pending = new Set<PendingBatch>()
  private pendingKeys = new Set<string>()
  private translated = new Set<string>()
  private failed = new Map<
    string,
    { phase: "cooling" | "permanent"; attempts: number; retryAt: number }
  >()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private tickQueued = false
  private lastEmittedState: SubtitlesState = "idle"
  private videoContext: SubtitlesVideoContext = { videoTitle: "", subtitlesTextContent: "" }

  constructor(private options: TranslationCoordinatorOptions) {
    this.session = options.session ?? new SubtitleSession()
    this.session.own(() => this.stop())
  }
  start(videoContext?: SubtitlesVideoContext) {
    if (videoContext) this.videoContext = videoContext
    const video = this.options.getVideoElement()
    if (!video) return
    this.session.start()
    this.active = true
    if (this.video !== video) {
      this.detach()
      this.video = video
      for (const event of EVENTS) video.addEventListener(event, this.requestTick)
    }
    this.options.segmentationPipeline?.start()
    this.requestTick()
  }
  stop() {
    this.active = false
    clearTimeout(this.retryTimer)
    this.session.stop()
    this.pending.clear()
    this.pendingKeys.clear()
    this.detach()
    this.options.segmentationPipeline?.stop()
  }
  reset() {
    this.stop()
    this.translated.clear()
    this.failed.clear()
    this.lastEmittedState = "idle"
  }
  clearFailed() {
    this.failed.clear()
  }
  private detach() {
    if (this.video)
      for (const event of EVENTS) this.video.removeEventListener(event, this.requestTick)
    this.video = null
  }
  /** Collapse same-turn scrubbing events without delaying ordinary zero-second startup. */
  requestTick = () => {
    if (!this.active || !this.session.isActive || this.tickQueued) return
    this.tickQueued = true
    queueMicrotask(() => {
      this.tickQueued = false
      if (this.active) this.handleTranslationTick()
    })
  }
  noteFragmentListChanged() {
    const timeline = getCueTimeline(this.options.getFragments())
    for (const key of this.translated) if (!timeline.has(key)) this.translated.delete(key)
    for (const key of this.failed.keys()) if (!timeline.has(key)) this.failed.delete(key)
    this.requestTick()
  }
  private cancelBatch(batch: PendingBatch) {
    batch.task.cancel()
    this.pending.delete(batch)
    for (const cue of batch.cues) this.pendingKeys.delete(cueIdentity(cue))
  }
  private handleTranslationTick = () => {
    if (!this.active || !this.session.isActive) return
    if (subtitlesStore.get(adPlayingAtom)) {
      for (const batch of [...this.pending]) this.cancelBatch(batch)
      this.options.segmentationPipeline?.stop()
      return
    }
    const video = this.options.getVideoElement()
    if (!video) return
    const timeMs = video.currentTime * 1000
    const fragments = this.options.getFragments()
    const timeline = getCueTimeline(fragments)
    const ahead = effectiveLookAheadMs(TRANSLATE_LOOK_AHEAD_MS, video.playbackRate)
    const relevant = (cue: SubtitlesFragment) =>
      cue.end > timeMs && cue.start <= timeMs + ahead && timeline.has(cueIdentity(cue))
    // Cancel obsolete pending work before admitting the new current position.
    for (const batch of [...this.pending])
      if (!batch.cues.some(relevant) || batch.cues.some((c) => !timeline.has(cueIdentity(c))))
        this.cancelBatch(batch)
    this.options.segmentationPipeline?.reprioritize?.()
    this.updateLoadingStateAt(timeMs, fragments)
    clearTimeout(this.retryTimer)
    let nextRetry = Infinity
    const window = timeline.window(timeMs, timeMs + ahead + 1)
    for (const cue of window) {
      const failure = this.failed.get(cueIdentity(cue))
      if (failure?.phase === "cooling" && failure.retryAt > Date.now())
        nextRetry = Math.min(nextRetry, failure.retryAt)
    }
    if (Number.isFinite(nextRetry))
      this.retryTimer = setTimeout(this.requestTick, nextRetry - Date.now())
    const candidates = window.filter(
      (c) =>
        !this.translated.has(cueIdentity(c)) &&
        !this.pendingKeys.has(cueIdentity(c)) &&
        this.failed.get(cueIdentity(c))?.phase !== "permanent" &&
        (this.failed.get(cueIdentity(c))?.retryAt ?? 0) <= Date.now(),
    )
    // Window returns all currently covering cues first (including long cues), then future cues.
    if (
      candidates[0] &&
      candidates[0].start <= timeMs &&
      this.pending.size >= MAX_PENDING_BATCHES
    ) {
      const future = [...this.pending].filter((b) => b.cues.every((c) => c.start > timeMs)).at(-1)
      if (future) this.cancelBatch(future)
    }
    while (this.pending.size < MAX_PENDING_BATCHES && candidates.length) {
      const cues = candidates.splice(0, TRANSLATION_BATCH_SIZE)
      const task = this.session.begin(
        "playback",
        cues.map(cueIdentity).join("|"),
        cues[0]!.start <= timeMs ? 0 : cues[0]!.start <= timeMs + 10_000 ? 1 : 2,
      )
      const batch = { task, cues }
      this.pending.add(batch)
      for (const cue of cues) this.pendingKeys.add(cueIdentity(cue))
      void this.translateBatch(batch)
    }
  }
  private async translateBatch(batch: PendingBatch) {
    const { task, cues } = batch
    let config: Config | null = null
    const context = { ...this.videoContext }
    try {
      config = this.options.configSnapshot ?? (await getLocalConfig())
      if (!task.isCurrent()) return
      const translated = await translateSubtitles(cues, context, config ?? undefined, task)
      if (!task.isCurrent()) return
      const timeline = getCueTimeline(this.options.getFragments())
      const requested = new Set(cues.map(cueIdentity))
      const valid = translated.filter(
        (c) => requested.has(cueIdentity(c)) && timeline.has(cueIdentity(c)),
      )
      const returned = new Set(valid.map(cueIdentity))
      for (const key of requested)
        if (!returned.has(key))
          this.recordFailure(key, { status: "temporary", message: "Missing subtitle result" })
      const publish = valid.map((cue) => {
        const status = cue.translationOutcome?.status
        if (status === "success" || status === "empty" || (!status && cue.translation?.trim())) {
          this.translated.add(cueIdentity(cue))
          this.failed.delete(cueIdentity(cue))
          return cue
        }
        this.recordFailure(
          cueIdentity(cue),
          cue.translationOutcome ?? { status: "temporary", message: "Missing translation" },
        )
        return this.fallback(cue, config)
      })
      this.options.onTranslated(publish)
    } catch (error) {
      if (!task.isCurrent()) return
      if (isExtensionContextInvalidatedError(error)) {
        this.stop()
        this.options.onStateChange("idle")
        return
      }
      const timeline = getCueTimeline(this.options.getFragments())
      const valid = cues.filter((c) => timeline.has(cueIdentity(c)))
      for (const cue of valid) this.recordFailure(cueIdentity(cue), subtitleFailure(error))
      this.options.onTranslated(
        valid.map((c) =>
          this.fallback({ ...c, translationOutcome: subtitleFailure(error) }, config),
        ),
      )
      this.lastEmittedState = "error"
      this.options.onStateChange("error", {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (this.pending.delete(batch))
        for (const cue of cues) this.pendingKeys.delete(cueIdentity(cue))
      task.complete()
      this.requestTick()
    }
  }
  private fallback(cue: SubtitlesFragment, config: Config | null): SubtitlesFragment {
    return {
      ...cue,
      translation: config?.videoSubtitles.style.displayMode === "translationOnly" ? cue.text : "",
    }
  }
  private recordFailure(key: string, outcome: SubtitleOutcome) {
    if (outcome.status === "success" || outcome.status === "empty") return
    const attempts = (this.failed.get(key)?.attempts ?? 0) + 1
    const permanent =
      outcome.status === "permanent" || outcome.status === "cancelled" || attempts >= 2
    this.failed.set(key, {
      phase: permanent ? "permanent" : "cooling",
      attempts,
      retryAt: Date.now() + Math.max(30_000, outcome.retryAfterMs ?? 0),
    })
  }
  private updateLoadingStateAt(timeMs: number, fragments: SubtitlesFragment[]) {
    const active = getCueTimeline(fragments).at(timeMs)
    const next =
      active && !this.translated.has(cueIdentity(active)) && !this.failed.has(cueIdentity(active))
        ? "loading"
        : "idle"
    if (
      next !== this.lastEmittedState ||
      (this.options.getCurrentState() === "loading" && next === "idle")
    ) {
      this.lastEmittedState = next
      this.options.onStateChange(next)
    }
  }
}
