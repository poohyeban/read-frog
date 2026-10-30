import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { PROCESS_LOOK_AHEAD_MS } from "@/utils/constants/subtitles"
import { freezeData } from "@/utils/immutable"
import { effectiveLookAheadMs } from "@/utils/subtitles/lookahead"
import { aiSegmentBlock } from "@/utils/subtitles/processor/ai-segmentation"
import { optimizeSubtitles } from "@/utils/subtitles/processor/optimizer"
import { SubtitleSession, type SubtitleTask } from "@/utils/subtitles/session"

export type ChunkSegmentedHandler = (
  chunk: SubtitlesFragment[],
  nextFragments: SubtitlesFragment[],
) => void

export class SegmentationPipeline {
  // Segmented results, read by translation pipeline
  processedFragments: SubtitlesFragment[] = []

  private rawFragments: SubtitlesFragment[]
  private segmentedRawStarts = new Set<number>()
  private aiSegmentFailedRawStarts = new Set<number>()
  private session: SubtitleSession
  private task: SubtitleTask | null = null
  private generation = 0
  private running = false
  private stopped = false

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
    this.rawFragments = options.rawFragments
    this.processedFragments = [...(options.baselineFragments ?? [])]
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
    return this.rawFragments.some((f) => !this.segmentedRawStarts.has(f.start))
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
  }

  restart() {
    void this.runLoop()
  }

  clearFailedStarts() {
    for (const start of this.aiSegmentFailedRawStarts) {
      this.segmentedRawStarts.delete(start)
    }
    this.aiSegmentFailedRawStarts.clear()
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
    if (this.stopped) return false

    const chunk = this.findNextChunk(currentTimeMs)
    if (chunk.length === 0) return false

    if (this.preSegmented) {
      chunk.forEach((f) => this.segmentedRawStarts.add(f.start))
      this.replaceProcessedChunk(chunk, chunk)
      return true
    }

    if (!this.providerRef) {
      // Do not leave starts marked segmented with no replacement (would skip forever).
      const optimized = optimizeSubtitles(chunk, this.getSourceLanguage())
      chunk.forEach((f) => this.segmentedRawStarts.add(f.start))
      this.replaceProcessedChunk(chunk, optimized)
      return true
    }

    const task = this.session.begin("segmentation", String(chunk[0]!.start))
    this.task = task
    try {
      const segmented = await aiSegmentBlock(chunk, this.providerRef, task)
      // Session may have been torn down while the AI call was in flight.
      if (this.stopped || generation !== this.generation || !task.isCurrent()) return false
      const optimized = optimizeSubtitles(segmented, this.getSourceLanguage())
      chunk.forEach((f) => this.segmentedRawStarts.add(f.start))
      this.replaceProcessedChunk(chunk, optimized)
    } catch {
      if (this.stopped || generation !== this.generation || !task.isCurrent()) return false
      chunk.forEach((f) => this.aiSegmentFailedRawStarts.add(f.start))
      const optimized = optimizeSubtitles(chunk, this.getSourceLanguage())
      chunk.forEach((f) => this.segmentedRawStarts.add(f.start))
      this.replaceProcessedChunk(chunk, optimized)
    } finally {
      task.complete()
      if (this.task === task) this.task = null
    }

    return true
  }

  private replaceProcessedChunk(chunk: SubtitlesFragment[], nextFragments: SubtitlesFragment[]) {
    // Do not mutate processed fragments or notify the adapter after stop().
    if (this.stopped) return

    const chunkStart = chunk[0]!.start
    const chunkEnd = chunk.at(-1)!.end

    // Drop any cue that overlaps the window (not just cues whose start falls inside it).
    // Half-open: keep if end <= chunkStart || start >= chunkEnd.
    this.processedFragments = this.processedFragments.filter(
      (fragment) => fragment.end <= chunkStart || fragment.start >= chunkEnd,
    )
    this.processedFragments.push(...nextFragments)
    this.processedFragments.sort((a, b) => a.start - b.start)

    this.onChunkSegmented?.(chunk, nextFragments)
  }

  private findNextChunk(currentTimeMs: number): SubtitlesFragment[] {
    const searchStart = Math.max(0, currentTimeMs - 10_000)
    const firstUnprocessed = this.rawFragments.find(
      (f) => f.start >= searchStart && !this.segmentedRawStarts.has(f.start),
    )
    if (!firstUnprocessed) return []

    // Only segment chunks within the look-ahead window ahead of the current
    // position. Without this bound the loop keeps segmenting until the end of
    // the video regardless of how far playback has actually reached, which
    // eagerly sends the entire remaining video to the AI segmentation model.
    // Chunks further ahead are picked up later, once playback advances and the
    // translation coordinator restarts the pipeline.
    const lookAheadMs = effectiveLookAheadMs(
      PROCESS_LOOK_AHEAD_MS,
      this.getVideoElement()?.playbackRate,
    )
    if (firstUnprocessed.start > currentTimeMs + lookAheadMs) return []

    const windowEnd = firstUnprocessed.start + lookAheadMs
    return this.rawFragments.filter(
      (f) =>
        f.start >= firstUnprocessed.start &&
        f.start < windowEnd &&
        !this.segmentedRawStarts.has(f.start),
    )
  }
}
