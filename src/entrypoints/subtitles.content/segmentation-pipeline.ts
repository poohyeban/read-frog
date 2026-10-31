import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { SubtitleTraceSink } from "@/utils/subtitles/diagnostics"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { PROCESS_LOOK_AHEAD_MS } from "@/utils/constants/subtitles"
import { freezeData } from "@/utils/immutable"
import { CueTimeline, cueIdentity, getCueTimeline } from "@/utils/subtitles/cue-timeline"
import { effectiveLookAheadMs } from "@/utils/subtitles/lookahead"
import { aiSegmentBlock } from "@/utils/subtitles/processor/ai-segmentation"
import { optimizeSubtitles } from "@/utils/subtitles/processor/optimizer"
import { SubtitleSession, type SubtitleTask } from "@/utils/subtitles/session"
import { chunkSubtitleWork } from "@/utils/subtitles/work-policy"

export type ChunkSegmentedHandler = (
  chunk: SubtitlesFragment[],
  nextFragments: SubtitlesFragment[],
) => void

export class SegmentationPipeline {
  // Segmented results, read by translation pipeline
  processedFragments: SubtitlesFragment[] = []

  private processedChunks = new Map<string, SubtitlesFragment[]>()
  restore(cues: SubtitlesFragment[]) {
    this.processedFragments = [...new CueTimeline(this.processedFragments).upsert(cues).cues]
  }
  private chunks: SubtitlesFragment[][]
  private chunkTimeline: CueTimeline
  private completed = new Set<string>()
  private failed = new Set<string>()
  private processingChunk: SubtitlesFragment[] | null = null
  private session: SubtitleSession
  private task: SubtitleTask | null = null
  private generation = 0
  private running = false
  private stopped = false
  private admission: () => boolean = () => true
  private trace?: SubtitleTraceSink
  setDiagnostics(trace?: SubtitleTraceSink) {
    this.trace = trace
  }
  private onLatency?: (ms: number) => void
  setLatencyObserver(observer: (ms: number) => void) {
    this.onLatency = observer
  }
  setAdmission(admission: () => boolean) {
    this.admission = admission
  }

  private getVideoElement: () => HTMLVideoElement | null
  private getSourceLanguage: () => string
  private preSegmented: boolean
  private onChunkSegmented: ChunkSegmentedHandler | null

  private providerRef: PromptableProviderRef | null

  constructor(options: {
    session?: SubtitleSession
    baselineFragments?: SubtitlesFragment[]
    rawFragments: SubtitlesFragment[]
    getVideoElement: () => HTMLVideoElement | null
    getSourceLanguage: () => string
    providerRef: PromptableProviderRef | null
    preSegmented?: boolean
    onChunkSegmented?: ChunkSegmentedHandler
  }) {
    this.session = options.session ?? new SubtitleSession()
    this.session.own(() => this.stop())
    const raw = [...getCueTimeline(options.rawFragments).cues]
    this.chunks = chunkSubtitleWork(raw)
    this.chunkTimeline = new CueTimeline(
      this.chunks.map((c, index) => ({
        start: c[0]!.start,
        end: c.reduce((end, f) => Math.max(end, f.end), 0),
        text: String(index),
      })),
    )
    this.processedFragments = []
    this.getVideoElement = options.getVideoElement
    this.getSourceLanguage = options.getSourceLanguage
    this.providerRef = freezeData(structuredClone(options.providerRef))
    this.preSegmented = options.preSegmented ?? false
    this.onChunkSegmented = options.onChunkSegmented ?? null
  }

  get isRunning(): boolean {
    return this.running
  }

  hasUnprocessedChunks(): boolean {
    return this.completed.size < this.chunks.length
  }

  start() {
    this.session.start()
    this.stopped = false
    void this.runLoop()
  }

  stop() {
    this.stopped = true
    this.generation++
    this.running = false
    this.task?.cancel()
    this.task = null
    this.processingChunk = null
  }

  restart() {
    this.start()
  }

  /** Reuse the active window; cancel only work that no longer serves this position. */
  reprioritize() {
    const video = this.getVideoElement()
    if (!video || !this.admission()) return
    const time = video.currentTime * 1000
    const ahead = effectiveLookAheadMs(PROCESS_LOOK_AHEAD_MS, video.playbackRate)
    if (
      this.processingChunk &&
      !this.processingChunk.some((c) => c.end > time && c.start <= time + ahead)
    )
      this.stop()
    if (!this.running) this.start()
  }

  clearFailedStarts() {
    for (const key of this.failed) this.completed.delete(key)
    this.failed.clear()
  }

  private async runLoop() {
    if (this.running) return
    this.running = true
    const generation = this.generation

    const video = this.getVideoElement()
    if (!video) {
      this.running = false
      return
    }

    try {
      while (!this.stopped && generation === this.generation && this.hasUnprocessedChunks()) {
        const didWork = await this.processNextChunk(video.currentTime * 1000, generation)
        if (!didWork) break
      }
    } finally {
      if (generation === this.generation) this.running = false
    }
  }

  private async processNextChunk(
    currentTimeMs: number,
    generation = this.generation,
  ): Promise<boolean> {
    if (this.stopped || !this.admission()) return false

    const chunk = this.findNextChunk(currentTimeMs)
    if (chunk.length === 0) return false
    const key = cueIdentity(chunk[0]!)

    if (this.preSegmented) {
      this.completed.add(key)
      this.replaceProcessedChunk(chunk, chunk)
      return true
    }

    if (!this.providerRef) {
      // Do not leave starts marked segmented with no replacement (would skip forever).
      const optimized = optimizeSubtitles(chunk, this.getSourceLanguage())
      this.completed.add(key)
      this.replaceProcessedChunk(chunk, optimized)
      return true
    }

    const task = this.session.begin(
      "segmentation",
      String(chunk[0]!.start),
      chunk.some((c) => c.start <= currentTimeMs && c.end > currentTimeMs) ? 1 : 3,
    )
    this.task = task
    this.processingChunk = chunk
    const started = Date.now()
    this.trace?.({
      event: "segmentation-start",
      lane: "segmentation",
      mediaTimeMs: currentTimeMs,
      value: chunk.length,
    })
    try {
      const segmented = await aiSegmentBlock(chunk, this.providerRef, task)
      // Session may have been torn down while the AI call was in flight.
      if (this.stopped || generation !== this.generation || !task.isCurrent()) return false
      this.trace?.({
        event: "segmentation-complete",
        lane: "segmentation",
        mediaTimeMs: currentTimeMs,
        value: segmented.length,
      })
      this.onLatency?.(Date.now() - started)
      const optimized = segmented
      this.completed.add(key)
      this.replaceProcessedChunk(chunk, optimized)
    } catch {
      if (this.stopped || generation !== this.generation || !task.isCurrent()) return false
      this.failed.add(key)
      this.completed.add(key)
      // Invalid/failed AI results never become Quality Ready; Fast remains independent.
    } finally {
      task.complete()
      if (this.task === task) {
        this.task = null
        this.processingChunk = null
      }
    }

    return true
  }

  private replaceProcessedChunk(chunk: SubtitlesFragment[], nextFragments: SubtitlesFragment[]) {
    // Do not mutate processed fragments or notify the adapter after stop().
    if (this.stopped) return

    this.processedChunks.set(cueIdentity(chunk[0]!), nextFragments)
    // Chunk ownership, rather than overlapping timestamps, preserves dense parallel cues.
    this.restore([...this.processedChunks.values()].flat())

    this.onChunkSegmented?.(chunk, nextFragments)
  }

  private findNextChunk(currentTimeMs: number): SubtitlesFragment[] {
    const ahead = effectiveLookAheadMs(PROCESS_LOOK_AHEAD_MS, this.getVideoElement()?.playbackRate)
    for (const window of this.chunkTimeline.window(currentTimeMs, currentTimeMs + ahead + 1)) {
      const chunk = this.chunks[Number(window.text)]!
      if (!this.completed.has(cueIdentity(chunk[0]!))) return chunk
    }
    return []
  }
}
