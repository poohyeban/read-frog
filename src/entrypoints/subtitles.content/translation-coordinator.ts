import type { SegmentationPipeline } from "./segmentation-pipeline"
import type { Config } from "@/types/config/config"
import type { SubtitleTraceSink, SubtitleTrace } from "@/utils/subtitles/diagnostics"
import type { SubtitlesVideoContext } from "@/utils/subtitles/processor/translator"
import type {
  SubtitleCandidateBundle,
  SubtitlesFragment,
  SubtitlesState,
} from "@/utils/subtitles/types"
import {
  getPerformanceOverrides,
  getPerformanceSnapshot,
  watchPerformance,
} from "@/utils/config/performance"
import { getLocalConfig } from "@/utils/config/storage"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { RESOURCE_DEFAULTS } from "@/utils/request/resource-policy"
import { continuousReadyMs, SubtitleBufferController } from "@/utils/subtitles/continuous-buffer"
import { cueIdentity, getCueTimeline } from "@/utils/subtitles/cue-timeline"
import { translateSubtitles, fetchSubtitlesSummary } from "@/utils/subtitles/processor/translator"
import { subtitleFailure, type SubtitleOutcome } from "@/utils/subtitles/result"
import { SubtitleSession, type SubtitleTask } from "@/utils/subtitles/session"
import { boundedSourceCues, chunkSubtitleWork } from "@/utils/subtitles/work-policy"
import { adPlayingAtom, subtitlesStore } from "./atoms"

export interface TranslationCoordinatorOptions {
  trace?: SubtitleTraceSink
  candidateCache?: {
    read: (start: number, end: number, signal?: AbortSignal) => Promise<SubtitleCandidateBundle[]>
    write: (cues: SubtitlesFragment[], lane: "fast" | "quality", lease: string) => Promise<void>
  }
  session?: SubtitleSession
  configSnapshot?: Config
  canRequest?: () => boolean
  getConcurrency?: () => Promise<number>
  getFragments: () => SubtitlesFragment[]
  getVideoElement: () => HTMLVideoElement | null
  getCurrentState: () => SubtitlesState
  segmentationPipeline: SegmentationPipeline | null
  onTranslated: (fragments: SubtitlesFragment[], lane?: "fast" | "quality") => void
  onStateChange: (state: SubtitlesState, data?: Record<string, string>) => void
}
interface PendingBatch {
  lane: "fast" | "quality"
  started: number
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

/** Local windows are bounded; physical admission belongs to ResourceScheduler. */
export class TranslationCoordinator {
  private session: SubtitleSession
  private active = false
  private video: HTMLVideoElement | null = null
  private pending = new Set<PendingBatch>()
  private pendingKeys = new Set<string>()
  private translated = new Set<string>()
  private ready = {
    fast: new Map<string, SubtitlesFragment>(),
    quality: new Map<string, SubtitlesFragment>(),
  }
  private fastSource?: SubtitlesFragment[]
  private fastFragments: SubtitlesFragment[] = []
  private getFastFragments() {
    const source = this.options.getFragments()
    if (source !== this.fastSource) {
      this.fastSource = source
      this.fastFragments = boundedSourceCues(source)
    }
    return this.fastFragments
  }
  private cacheWindows = new Set<number>()
  private cacheTask: SubtitleTask | null = null
  // A background read may ignore Abort. Keep its physical occupancy across seeks
  // and stop/start, while bounding how long playback waits for it.
  private cacheReadInFlight = false
  private cacheWaitTimer: ReturnType<typeof setTimeout> | undefined
  private cacheRetryAfter = 0
  private readyList = { fast: [] as SubtitlesFragment[], quality: [] as SubtitlesFragment[] }
  private buffer = new SubtitleBufferController()
  private unwatchPerformance?: () => void
  private concurrency = 1
  private policyRevision = 0
  refreshResourcePolicy() {
    const revision = ++this.policyRevision
    const configured =
      getPerformanceOverrides().providers?.[
        this.options.configSnapshot?.videoSubtitles.providerId ?? ""
      ]?.maxInFlight ?? RESOURCE_DEFAULTS.maxInFlight
    if (!this.options.getConcurrency) {
      this.concurrency = configured
      return
    }
    void this.options
      .getConcurrency()
      .then((value) => {
        if (revision !== this.policyRevision || !this.active) return
        this.concurrency = value
        this.requestTick()
      })
      .catch(() => {})
  }
  private contextWindows = new Set<string>()
  private contextTask: SubtitleTask | null = null
  private failed = new Set<string>()
  private tickQueued = false
  private lastEmittedState: SubtitlesState = "idle"
  private videoContext: SubtitlesVideoContext = { videoTitle: "", subtitlesTextContent: "" }

  constructor(private options: TranslationCoordinatorOptions) {
    this.session = options.session ?? new SubtitleSession()
    this.session.own(() => this.stop())
  }
  private trace(event: SubtitleTrace["event"], lane?: SubtitleTrace["lane"], value?: number) {
    this.options.trace?.({
      event,
      lane,
      value,
      mediaTimeMs: (this.options.getVideoElement()?.currentTime ?? 0) * 1000,
    })
  }
  start(videoContext?: SubtitlesVideoContext) {
    if (videoContext) this.videoContext = videoContext
    const video = this.options.getVideoElement()
    if (!video) return
    this.session.start()
    this.active = true
    this.refreshResourcePolicy()
    this.buffer.configure(getPerformanceSnapshot().subtitles)
    this.unwatchPerformance ??= watchPerformance(() => {
      this.buffer.configure(getPerformanceSnapshot().subtitles)
      this.refreshResourcePolicy()
      this.requestTick()
    })
    if (this.video !== video) {
      this.detach()
      this.video = video
      for (const event of EVENTS) video.addEventListener(event, this.requestTick)
    }
    this.options.segmentationPipeline?.setAdmission(() => this.canPrepareQuality())
    this.options.segmentationPipeline?.setLatencyObserver((ms) => this.buffer.observe(ms, true))
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.requestTick)
    this.requestTick()
  }
  stop(): Promise<void> {
    this.active = false
    this.policyRevision++
    this.unwatchPerformance?.()
    this.unwatchPerformance = undefined
    this.trace("stop-requested")
    const stopped = this.session.stop()
    this.pending.clear()
    this.pendingKeys.clear()
    this.contextTask = null
    this.cacheTask = null
    this.cacheWindows.clear()
    this.detach()
    this.options.segmentationPipeline?.stop()
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.requestTick)
    const acknowledged = stopped.then(
      () => {
        this.trace("stopped")
      },
      (error) => {
        this.trace("stop-failed")
        throw error
      },
    )
    void acknowledged.catch(() => {})
    return acknowledged
  }
  reset() {
    void this.stop()
    this.translated.clear()
    this.ready.fast.clear()
    this.ready.quality.clear()
    this.readyList = { fast: [], quality: [] }
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
  requestTick = (event?: Event) => {
    if (event) this.trace(event.type === "seeking" ? "seek" : "playback")
    if (!this.active || !this.session.isActive || this.tickQueued) return
    this.tickQueued = true
    queueMicrotask(() => {
      this.tickQueued = false
      if (this.active) this.handleTranslationTick()
    })
  }
  noteFragmentListChanged() {
    this.requestTick()
  }
  private cancelBatch(batch: PendingBatch) {
    this.trace("task-cancel", batch.lane, batch.cues.length)
    batch.task.cancel()
    this.pending.delete(batch)
    for (const cue of batch.cues) this.pendingKeys.delete(`${batch.lane}:${cueIdentity(cue)}`)
  }
  private isHidden() {
    return globalThis.document?.visibilityState === "hidden"
  }
  private canPrepareQuality() {
    if (
      !this.active ||
      this.options.canRequest?.() === false ||
      this.isHidden() ||
      subtitlesStore.get(adPlayingAtom)
    )
      return false
    const video = this.options.getVideoElement()
    if (!video) return false
    if (this.concurrency > 1) return true
    const rate = Math.min(4, Math.max(0.25, video.playbackRate || 1))
    const ready = [...this.readyList.fast, ...this.readyList.quality]
    const coverage =
      continuousReadyMs(this.getFastFragments(), ready, video.currentTime * 1000, 240_000) / rate
    // A running remote call cannot be preempted. With one slot, first build enough Fast runway.
    return coverage >= this.buffer.qualityEstimateMs + this.buffer.lowMs
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
    if (this.restoreCandidates(timeMs)) return
    // Cache restoration and display selection always run, even with admission disabled.
    if (this.options.canRequest?.() === false) {
      this.options.onStateChange("idle")
      return
    }
    const rate = Math.min(4, Math.max(0.25, video.playbackRate || 1))
    const policy = getPerformanceSnapshot().subtitles
    const ahead = Math.min(300_000, Math.max(policy.fastAheadMs, this.buffer.highMs) * rate)
    const source = this.getFastFragments()
    const qualityCoverage = continuousReadyMs(source, this.readyList.quality, timeMs, ahead)
    const wasSpeculating = this.buffer.fastSpeculation
    const allowFastSpeculation = this.buffer.update(qualityCoverage, rate) && !this.isHidden()
    this.trace("buffer", "quality", qualityCoverage)
    if (wasSpeculating !== this.buffer.fastSpeculation)
      this.trace(this.buffer.fastSpeculation ? "fast-resume" : "fast-suspend", "fast")
    for (const batch of [...this.pending]) {
      const batchAhead =
        batch.lane === "quality" ? Math.min(300_000, policy.qualityAheadMs * rate) : ahead
      const relevant = batch.cues.some((c) => c.end > timeMs && c.start < timeMs + batchAhead)
      const speculativeFast =
        batch.lane === "fast" &&
        !allowFastSpeculation &&
        batch.cues.every((c) => c.start > timeMs + this.buffer.lowMs * rate)
      if (!relevant || speculativeFast) this.cancelBatch(batch)
    }
    for (const lane of ["fast", "quality"] as const) {
      if (lane === "quality" && this.isHidden()) continue
      const fragments =
        lane === "fast" ? source : (this.options.segmentationPipeline?.processedFragments ?? [])
      const timeline = getCueTimeline(fragments)
      const laneAhead =
        lane === "quality"
          ? Math.min(300_000, policy.qualityAheadMs * rate)
          : !allowFastSpeculation
            ? Math.min(ahead, this.buffer.lowMs * rate)
            : ahead
      const candidates = timeline.window(timeMs, timeMs + laneAhead, 128).filter((c) => {
        const key = `${lane}:${cueIdentity(c)}`
        // A complete quality interval makes the corresponding Fast request unnecessary.
        if (
          lane === "fast" &&
          continuousReadyMs(
            [c],
            this.readyList.quality,
            Math.max(timeMs, c.start),
            c.end - Math.max(timeMs, c.start),
          ) >=
            c.end - Math.max(timeMs, c.start)
        )
          return false
        return !this.translated.has(key) && !this.pendingKeys.has(key) && !this.failed.has(key)
      })
      const pending = [...this.pending].filter((b) => b.lane === lane)
      if (
        candidates[0] &&
        candidates[0].start <= timeMs &&
        pending.length >= policy.maxPendingBatches
      ) {
        const future = pending.filter((b) => b.cues.every((c) => c.start > timeMs)).at(-1)
        if (future) this.cancelBatch(future)
      }
      const batches = chunkSubtitleWork(candidates, policy.batchSize)
      for (const cues of batches) {
        if ([...this.pending].filter((b) => b.lane === lane).length >= policy.maxPendingBatches)
          break
        const urgent = lane === "fast" && cues[0]!.start <= timeMs + this.buffer.lowMs * rate
        const task = this.session.begin(
          "playback",
          cues.map(cueIdentity).join("|"),
          urgent ? 0 : lane === "fast" ? 1 : 2,
        )
        const batch: PendingBatch = { task, cues, lane, started: Date.now() }
        this.trace("task-created", lane, cues.length)
        this.pending.add(batch)
        for (const cue of cues) this.pendingKeys.add(`${lane}:${cueIdentity(cue)}`)
        void this.translateBatch(batch)
      }
    }
    this.options.segmentationPipeline?.reprioritize()
    this.prepareContext(timeMs, ahead)
    this.updateLoadingStateAt(timeMs, source)
  }
  private restoreCandidates(timeMs: number): boolean {
    const cache = this.options.candidateCache
    if (!cache) return false
    const window = Math.floor(timeMs / 60_000)
    if (this.cacheTask?.key === String(window)) return this.cacheWaitTimer !== undefined
    if (this.cacheTask) {
      this.cacheTask.cancel()
      this.cacheTask = null
    }
    if (
      this.cacheReadInFlight ||
      this.cacheWindows.has(window) ||
      Date.now() < this.cacheRetryAfter
    )
      return false
    const task = this.session.begin("context", String(window), 3)
    this.cacheTask = task
    this.cacheReadInFlight = true
    const policy = getPerformanceSnapshot().subtitles
    let restoreSucceeded = false
    const stopWaiting = () => {
      clearTimeout(this.cacheWaitTimer)
      this.cacheWaitTimer = undefined
    }
    task.signal.addEventListener("abort", stopWaiting, { once: true })
    this.cacheWaitTimer = setTimeout(() => {
      stopWaiting()
      this.cacheRetryAfter = Date.now() + policy.cacheRestoreRetryMs
      this.trace("cache-timeout")
      this.requestTick()
    }, policy.cacheRestoreTimeoutMs)
    void Promise.resolve()
      .then(() => {
        task.signal.throwIfAborted()
        const start = Math.max(0, window - 1) * 60_000
        return cache.read(start, start + 300_000, task.signal)
      })
      .then((bundles) => {
        if (!task.isCurrent()) return
        restoreSucceeded = true
        const restored = { fast: [] as SubtitlesFragment[], quality: [] as SubtitlesFragment[] }
        for (const bundle of bundles) {
          this.trace("cache-restored", bundle.lane, bundle.cues.length)
          for (const cue of bundle.cues) {
            this.ready[bundle.lane].set(cueIdentity(cue), cue)
            this.translated.add(`${bundle.lane}:${cueIdentity(cue)}`)
          }
          restored[bundle.lane].push(...bundle.cues)
        }
        if (restored.quality.length) this.options.segmentationPipeline?.restore(restored.quality)
        for (const lane of ["fast", "quality"] as const)
          if (restored[lane].length) this.options.onTranslated(restored[lane], lane)
        this.readyList = {
          fast: [...this.ready.fast.values()],
          quality: [...this.ready.quality.values()],
        }
        // A late cache response can cover work dispatched after the deadline.
        // Detach just those redundant subscribers, preserving unrelated work.
        for (const batch of [...this.pending]) {
          if (
            batch.cues.every(
              (cue) =>
                this.translated.has(`${batch.lane}:${cueIdentity(cue)}`) ||
                (batch.lane === "fast" &&
                  continuousReadyMs(
                    [cue],
                    this.readyList.quality,
                    cue.start,
                    cue.end - cue.start,
                  ) >=
                    cue.end - cue.start),
            )
          )
            this.cancelBatch(batch)
        }
      })
      .catch(() => {
        if (task.isCurrent()) {
          this.cacheRetryAfter = Date.now() + policy.cacheRestoreRetryMs
          this.trace("cache-failed")
        }
      })
      .finally(() => {
        stopWaiting()
        task.signal.removeEventListener("abort", stopWaiting)
        this.cacheReadInFlight = false
        if (task.isCurrent() && restoreSucceeded) {
          this.cacheWindows.add(window)
          if (this.cacheWindows.size > 256)
            this.cacheWindows.delete(this.cacheWindows.values().next().value!)
        }
        task.complete()
        if (this.cacheTask === task) this.cacheTask = null
        this.requestTick()
      })
    return true
  }
  private prepareContext(timeMs: number, ahead: number) {
    const config = this.options.configSnapshot
    if (!config?.pageTranslation.enableAIContentAware || this.contextTask || this.isHidden()) return
    const cues = chunkSubtitleWork(
      getCueTimeline(this.getFastFragments()).window(timeMs, timeMs + ahead, 32),
    )[0]
    if (!cues?.length) return
    const key = String(Math.floor(timeMs / 60_000))
    if (this.contextWindows.has(key)) return
    this.contextWindows.add(key)
    if (this.contextWindows.size > 256)
      this.contextWindows.delete(this.contextWindows.values().next().value!)
    const task = this.session.begin("context", key, 3)
    this.contextTask = task
    const context = {
      ...this.videoContext,
      subtitlesTextContent: cues
        .map((c) => c.text)
        .join(" ")
        .slice(0, 2400),
    }
    void fetchSubtitlesSummary(context, config, undefined, task)
      .then((summary) => {
        if (task.isCurrent() && summary) this.videoContext = { ...this.videoContext, summary }
      })
      .catch(() => {
        /* Context is optional; translation continues without it. */
      })
      .finally(() => {
        task.complete()
        if (this.contextTask === task) this.contextTask = null
      })
  }
  private async translateBatch(batch: PendingBatch) {
    const { task, cues, lane } = batch
    let config: Config | null = null
    const context = { ...this.videoContext }
    try {
      config = this.options.configSnapshot ?? (await getLocalConfig())
      if (!task.isCurrent()) return
      const translated = await translateSubtitles(cues, context, config ?? undefined, {
        ...task,
        lane,
      })
      if (!task.isCurrent()) {
        this.trace("stale-result", lane)
        return
      }
      const timeline = getCueTimeline(
        lane === "fast"
          ? this.getFastFragments()
          : (this.options.segmentationPipeline?.processedFragments ?? []),
      )
      const requested = new Set(cues.map(cueIdentity))
      const valid = translated.filter(
        (c) => requested.has(cueIdentity(c)) && timeline.has(cueIdentity(c)),
      )
      const returned = new Set(valid.map(cueIdentity))
      for (const key of requested)
        if (!returned.has(key))
          this.recordFailure(`${lane}:${key}`, {
            status: "temporary",
            message: "Missing subtitle result",
          })
      const publish = valid.map((cue) => {
        const status = cue.translationOutcome?.status
        if (status === "success" || status === "empty" || (!status && cue.translation?.trim())) {
          this.translated.add(`${lane}:${cueIdentity(cue)}`)
          this.ready[lane].set(cueIdentity(cue), cue)
          this.failed.delete(`${lane}:${cueIdentity(cue)}`)
          return cue
        }
        this.recordFailure(
          `${lane}:${cueIdentity(cue)}`,
          cue.translationOutcome ?? { status: "temporary", message: "Missing translation" },
        )
        return this.fallback(cue, config)
      })
      this.trace("ready", lane, valid.filter((c) => c.translation?.trim()).length)
      this.readyList[lane] = [...this.ready[lane].values()]
      const saved = publish.filter(
        (c) =>
          c.translationBatchKey &&
          c.translation?.trim() &&
          (!c.translationOutcome || c.translationOutcome.status === "success"),
      )
      if (saved.length && this.options.candidateCache) {
        const work = await task.prepareWork!(
          lane,
          cues[0]!.start,
          Math.max(...cues.map((c) => c.end)),
        )
        if (!task.isCurrent()) return
        void this.options.candidateCache.write(saved, lane, work.lease).catch(() => {})
      }
      this.buffer.observe(Date.now() - batch.started, lane === "quality")
      this.options.onTranslated(
        publish.filter(
          (c) =>
            c.translationOutcome?.status === "success" ||
            (!c.translationOutcome && c.translation?.trim()),
        ),
        lane,
      )
    } catch (error) {
      if (!task.isCurrent()) return
      if (isExtensionContextInvalidatedError(error)) {
        void this.stop()
        this.options.onStateChange("idle")
        return
      }
      const timeline = getCueTimeline(
        lane === "fast"
          ? this.getFastFragments()
          : (this.options.segmentationPipeline?.processedFragments ?? []),
      )
      const valid = cues.filter((c) => timeline.has(cueIdentity(c)))
      for (const cue of valid)
        this.recordFailure(`${lane}:${cueIdentity(cue)}`, subtitleFailure(error))
      this.options.onTranslated(
        valid.map((c) =>
          this.fallback({ ...c, translationOutcome: subtitleFailure(error) }, config),
        ),
        lane,
      )
      this.lastEmittedState = "error"
      this.options.onStateChange("error", {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (this.pending.delete(batch))
        for (const cue of cues) this.pendingKeys.delete(`${batch.lane}:${cueIdentity(cue)}`)
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
    // The shared request path owns all attempts. A business timer must not mint new credits.
    this.failed.add(key)
  }

  private updateLoadingStateAt(timeMs: number, fragments: SubtitlesFragment[]) {
    const active = getCueTimeline(fragments).at(timeMs)
    const next =
      active &&
      !this.ready.fast.has(cueIdentity(active)) &&
      !getCueTimeline(this.readyList.quality).at(timeMs) &&
      !this.failed.has(`fast:${cueIdentity(active)}`)
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
