import type { PlatformConfig } from "@/entrypoints/subtitles.content/platforms"
import type { Config } from "@/types/config/config"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { SubtitlesFetcher } from "@/utils/subtitles/fetchers/types"
import type { SubtitlesVideoContext } from "@/utils/subtitles/processor/translator"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { toastManager } from "@/components/ui/base-ui/toast"
import { getLocalConfig } from "@/utils/config/storage"
import { MAX_GAP_MS, TRANSLATION_BATCH_SIZE } from "@/utils/constants/subtitles"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { resolveLanguageCodeFromLocale } from "@/utils/content/page-language"
import { i18n } from "@/utils/i18n"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { cueIdentity } from "@/utils/subtitles/cue-timeline"
import { estimateSubtitleExport } from "@/utils/subtitles/export-estimate"
import { aiSegmentBlock } from "@/utils/subtitles/processor/ai-segmentation"
import { optimizeSubtitles } from "@/utils/subtitles/processor/optimizer"
import {
  buildSubtitlesSummaryContextHash,
  resolveSubtitlesProviderRef,
  fetchSubtitlesSummary,
  translateSubtitles,
} from "@/utils/subtitles/processor/translator"
import { SubtitleSession, type SubtitleTask } from "@/utils/subtitles/session"
import { downloadSubtitlesAsSrt } from "@/utils/subtitles/srt"
import { boundedSourceCues, chunkSubtitleWork } from "@/utils/subtitles/work-policy"
import {
  subtitlesStore,
  TranslatedDownloadPhase,
  translatedSubtitlesDownloadStatusAtom,
} from "./atoms"

const SUCCESS_MESSAGE_DURATION_MS = 4000
const MAX_COLLAPSED_AI_SEGMENT_DURATION_MS = 1
const TRANSLATED_EXPORT_BATCH_CONCURRENCY = 2

export class TranslatedSubtitlesDownloader {
  private session: SubtitleSession | null = null
  private task: SubtitleTask | null = null
  private isDownloading = false
  private operationId = 0
  private successTimeout: ReturnType<typeof setTimeout> | null = null
  private snapshotFetcher: SubtitlesFetcher | null = null

  constructor(
    private getFetcher: () => SubtitlesFetcher,
    private config: PlatformConfig,
  ) {}

  private get fetcher(): SubtitlesFetcher {
    return this.snapshotFetcher ?? this.getFetcher()
  }

  download = async (): Promise<void> => {
    if (this.isDownloading) {
      return
    }

    this.clearSuccessTimeout()
    this.isDownloading = true
    this.snapshotFetcher = this.getFetcher()
    const operationId = ++this.operationId
    const pageTitle = getSourceDocumentTitle()
    const videoId = this.config.getVideoId?.()
    this.session = new SubtitleSession({
      videoId: videoId ?? "",
      trackId: `export:${operationId}`,
      revision: operationId,
    })
    this.task = this.session.begin("export", "complete-srt")
    this.setStatus(TranslatedDownloadPhase.Checking, null)

    try {
      const loadedConfig = await getLocalConfig()
      const configSnapshot = loadedConfig ? structuredClone(loadedConfig) : null
      this.assertActive(operationId)
      if (!configSnapshot) {
        throw new Error(i18n.t("subtitles.errors.translatedExportFailed"))
      }

      this.degradedChunks = 0
      const sourceSubtitles = [...(await this.fetcher.fetch())].sort(
        (a, b) => a.start - b.start || a.end - b.end,
      )
      if (
        sourceSubtitles.some(
          (c) => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start,
        )
      )
        throw new Error(i18n.t("subtitles.errors.translatedExportIncomplete"))
      this.assertActive(operationId)
      if (sourceSubtitles.length === 0) {
        throw new Error(i18n.t("subtitles.errors.noSubtitlesFound"))
      }

      this.assertDifferentTargetLanguage(configSnapshot)
      const estimate = estimateSubtitleExport(
        sourceSubtitles,
        configSnapshot.videoSubtitles.aiSegmentation,
        Math.min(
          TRANSLATION_BATCH_SIZE,
          configSnapshot.videoSubtitles.batchQueueConfig.maxItemsPerBatch,
        ),
        configSnapshot.pageTranslation.enableAIContentAware,
      )
      if (
        estimate.needsConfirmation &&
        !window.confirm(
          i18n.t("subtitles.work.exportConfirm", [
            String(estimate.requests),
            String(estimate.estimatedTokens),
            String(estimate.hardRequests),
            String(estimate.hardTokens),
            String(estimate.inputCharacters),
          ]),
        )
      ) {
        this.setStatus(TranslatedDownloadPhase.Cancelled, null)
        return
      }
      this.assertActive(operationId)
      this.session?.dispose()
      this.session = new SubtitleSession(
        { videoId: videoId ?? "", trackId: `export:${operationId}`, revision: operationId },
        { requests: estimate.hardRequests, estimatedTokens: estimate.hardTokens },
      )
      this.task = this.session.begin("export", "complete-srt")
      this.setStatus(TranslatedDownloadPhase.Preparing, 0)

      const sourceProcessedSubtitles = this.fetcher.isPreSegmented?.()
        ? [...sourceSubtitles]
        : optimizeSubtitles(sourceSubtitles, this.fetcher.getSourceLanguage())
      const translatedSubtitles = await this.buildCompleteTranslatedSubtitles(
        sourceSubtitles,
        sourceProcessedSubtitles,
        configSnapshot,
        operationId,
        pageTitle,
      )

      this.assertActive(operationId)
      await downloadSubtitlesAsSrt({
        subtitles: translatedSubtitles.map(({ translation, ...fragment }) => ({
          ...fragment,
          text: translation ?? "",
        })),
        pageTitle,
        videoId,
        suffix: "translated",
      })
      this.assertActive(operationId)

      if (this.degradedChunks)
        toastManager.add({
          type: "warning",
          title: i18n.t("subtitles.work.degraded", [String(this.degradedChunks)]),
        })
      this.setStatus(TranslatedDownloadPhase.Complete, null)
      this.successTimeout = setTimeout(() => {
        if (!this.isActive(operationId)) {
          return
        }
        this.successTimeout = null
        this.setStatus(TranslatedDownloadPhase.Idle, null)
      }, SUCCESS_MESSAGE_DURATION_MS)
    } catch (error) {
      if (!this.isActive(operationId)) {
        return
      }
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : String(error),
      })
      this.setStatus(TranslatedDownloadPhase.Failed, null)
    } finally {
      if (this.isActive(operationId)) {
        this.session?.dispose()
        this.task = null
        this.isDownloading = false
        this.snapshotFetcher = null
      }
    }
  }

  cancel = async (): Promise<void> => {
    const cancelledOperation = ++this.operationId
    this.task?.cancel()
    const session = this.session
    this.session = null
    this.task = null
    this.snapshotFetcher = null
    this.clearSuccessTimeout()
    try {
      await session?.stop()
      session?.dispose()
      if (this.operationId === cancelledOperation) {
        this.isDownloading = false
        this.setStatus(TranslatedDownloadPhase.Cancelled, null)
      }
    } catch {
      if (this.operationId === cancelledOperation) {
        this.isDownloading = false
        this.setStatus(TranslatedDownloadPhase.Failed, null)
        toastManager.add({ type: "error", title: i18n.t("subtitles.work.stopFailed") })
      }
    }
  }

  dispose(): void {
    this.session?.dispose()
    this.task = null
    this.operationId++
    this.isDownloading = false
    this.snapshotFetcher = null
    this.clearSuccessTimeout()
    this.setStatus(TranslatedDownloadPhase.Idle, null)
  }

  private clearSuccessTimeout(): void {
    if (this.successTimeout !== null) {
      clearTimeout(this.successTimeout)
      this.successTimeout = null
    }
  }

  private setStatus(phase: TranslatedDownloadPhase, progress: number | null): void {
    subtitlesStore.set(translatedSubtitlesDownloadStatusAtom, { phase, progress })
  }

  private isActive(operationId: number): boolean {
    return operationId === this.operationId
  }

  private taskFor(operationId: number) {
    this.assertActive(operationId)
    return this.task ?? {}
  }

  private assertActive(operationId: number): void {
    if (!this.isActive(operationId)) {
      throw new Error("Translated subtitle download was disposed")
    }
  }

  private assertDifferentTargetLanguage(config: Config): void {
    const targetLanguage = config.language.targetCode
    const sourceLanguage = resolveLanguageCodeFromLocale(this.fetcher.getSourceLanguage())

    if (targetLanguage && sourceLanguage && sourceLanguage === targetLanguage) {
      throw new Error(i18n.t("subtitles.errors.translatedExportSameLanguage"))
    }
  }

  private async buildCompleteTranslatedSubtitles(
    sourceSubtitles: SubtitlesFragment[],
    sourceProcessedSubtitles: SubtitlesFragment[],
    config: Config,
    operationId: number,
    pageTitle: string,
  ): Promise<SubtitlesFragment[]> {
    // One resolve for the whole export: segmentation runs per 60s chunk, and a

    // The generation tasks (segmentation, summary) get the ref narrowed once
    // here — a translate-only provider exports the rule-based recut without a
    // doomed prompt attempt per chunk.
    const providerRef = await resolveSubtitlesProviderRef(config, "lineTranslation")
    const promptableProviderRef =
      providerRef && canProviderRefGenerateText(providerRef) ? providerRef : null
    this.assertActive(operationId)
    const useAi =
      config.videoSubtitles.aiSegmentation &&
      !this.fetcher.isPreSegmented?.() &&
      !!promptableProviderRef
    const chunks = chunkSubtitleWork(useAi ? sourceSubtitles : sourceProcessedSubtitles)
    const translatedFragments: SubtitlesFragment[] = []
    for (const [chunkIndex, chunk] of chunks.entries()) {
      this.assertActive(operationId)
      const fragments = boundedSourceCues(
        useAi
          ? await this.buildExportProcessedChunk(chunk, promptableProviderRef, operationId)
          : chunk,
      )
      const videoContext = await this.buildExportVideoContext(
        chunk,
        config,
        operationId,
        pageTitle,
        promptableProviderRef,
      )
      const batches = this.buildTranslationBatches(fragments)
      for (let index = 0; index < batches.length; index += TRANSLATED_EXPORT_BATCH_CONCURRENCY) {
        this.assertActive(operationId)
        const results = await Promise.all(
          batches.slice(index, index + TRANSLATED_EXPORT_BATCH_CONCURRENCY).map(async (batch) => {
            const translated = await translateSubtitles(
              batch,
              videoContext,
              config,
              this.taskFor(operationId),
            )
            this.assertActive(operationId)
            if (
              !this.matchesRequestedCues(batch, translated) ||
              this.hasIncompleteTranslatedFragments(translated)
            )
              throw new Error(i18n.t("subtitles.errors.translatedExportIncomplete"))
            return translated
          }),
        )
        for (const batch of results) translatedFragments.push(...batch)
        this.setStatus(
          TranslatedDownloadPhase.Translating,
          Math.round(
            (100 *
              (chunkIndex +
                Math.min(1, (index + TRANSLATED_EXPORT_BATCH_CONCURRENCY) / batches.length))) /
              chunks.length,
          ),
        )
      }
    }
    if (
      this.hasIncompleteTranslatedFragments(translatedFragments) ||
      this.hasTimingCoverageGap(sourceSubtitles, translatedFragments)
    )
      throw new Error(i18n.t("subtitles.errors.translatedExportIncomplete"))
    return translatedFragments.sort((a, b) => a.start - b.start || a.end - b.end)
  }

  private matchesRequestedCues(
    requested: SubtitlesFragment[],
    result: SubtitlesFragment[],
  ): boolean {
    if (requested.length !== result.length) return false
    const remaining = new Map<string, number>()
    for (const cue of requested) {
      const key = cueIdentity(cue)
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    for (const cue of result) {
      const key = cueIdentity(cue),
        count = remaining.get(key) ?? 0
      if (!count) return false
      remaining.set(key, count - 1)
    }
    return true
  }

  private hasIncompleteTranslatedFragments(fragments: SubtitlesFragment[]): boolean {
    return fragments.some(
      (fragment) =>
        !fragment.translation?.trim() ||
        (fragment.translationOutcome && fragment.translationOutcome.status !== "success"),
    )
  }

  private buildTranslationBatches(fragments: SubtitlesFragment[]): SubtitlesFragment[][] {
    return chunkSubtitleWork(fragments, TRANSLATION_BATCH_SIZE)
  }

  private degradedChunks = 0

  private async buildExportProcessedChunk(
    chunk: SubtitlesFragment[],
    providerRef: PromptableProviderRef,
    operationId: number,
  ): Promise<SubtitlesFragment[]> {
    const sourceLanguage = this.fetcher.getSourceLanguage()
    let segmented: SubtitlesFragment[]

    try {
      segmented = await aiSegmentBlock(chunk, providerRef, this.taskFor(operationId))
      this.assertActive(operationId)
    } catch {
      this.assertActive(operationId)
      this.degradedChunks++
      return optimizeSubtitles(chunk, sourceLanguage)
    }

    const optimized = segmented

    if (!this.hasUnsafeSegmentedExportTiming(chunk, segmented, optimized)) {
      return optimized
    }

    this.degradedChunks++
    return optimizeSubtitles(chunk, sourceLanguage)
  }

  private hasUnsafeExportTiming(
    source: SubtitlesFragment[],
    candidate: SubtitlesFragment[],
  ): boolean {
    return (
      this.hasInvalidTimingShape(source, candidate) || this.hasTimingCoverageGap(source, candidate)
    )
  }

  private hasUnsafeSegmentedExportTiming(
    source: SubtitlesFragment[],
    segmented: SubtitlesFragment[],
    optimized: SubtitlesFragment[],
  ): boolean {
    return (
      this.hasInvalidTimingShape(source, segmented) || this.hasUnsafeExportTiming(source, optimized)
    )
  }

  private hasTimingCoverageGap(
    source: SubtitlesFragment[],
    candidate: SubtitlesFragment[],
  ): boolean {
    const sourceCoverage = this.mergeCoverageIntervals(source)
    const candidateCoverage = this.mergeCoverageIntervals(candidate)

    for (const sourceInterval of sourceCoverage) {
      let coveredUntil = sourceInterval.start

      for (const candidateInterval of candidateCoverage) {
        if (candidateInterval.end <= coveredUntil) {
          continue
        }
        if (candidateInterval.start >= sourceInterval.end) {
          break
        }

        const overlapStart = Math.max(candidateInterval.start, sourceInterval.start)
        if (overlapStart - coveredUntil > MAX_GAP_MS) {
          return true
        }

        coveredUntil = Math.max(coveredUntil, Math.min(candidateInterval.end, sourceInterval.end))
      }

      if (sourceInterval.end - coveredUntil > MAX_GAP_MS) {
        return true
      }
    }

    return false
  }

  private hasInvalidTimingShape(
    source: SubtitlesFragment[],
    candidate: SubtitlesFragment[],
  ): boolean {
    if (source.length === 0 || candidate.length === 0) {
      return true
    }

    const sourceStart = Math.min(...source.map((fragment) => fragment.start))
    const sourceEnd = Math.max(...source.map((fragment) => fragment.end))
    const sortedCandidates = [...candidate].sort((a, b) => a.start - b.start || a.end - b.end)

    for (let index = 0; index < sortedCandidates.length; index++) {
      const fragment = sortedCandidates[index]
      if (
        !Number.isFinite(fragment!.start) ||
        !Number.isFinite(fragment!.end) ||
        fragment!.end - fragment!.start <= MAX_COLLAPSED_AI_SEGMENT_DURATION_MS ||
        fragment!.start < sourceStart ||
        fragment!.end > sourceEnd
      ) {
        return true
      }

      const previous = sortedCandidates[index - 1]
      if (previous && previous.end > fragment!.start) {
        return true
      }
    }

    return false
  }

  private mergeCoverageIntervals(
    fragments: SubtitlesFragment[],
  ): Array<{ start: number; end: number }> {
    const intervals = fragments
      .filter((fragment) => fragment.end > fragment.start)
      .map((fragment) => ({ start: fragment.start, end: fragment.end }))
      .sort((a, b) => a.start - b.start)

    const merged: Array<{ start: number; end: number }> = []

    for (const interval of intervals) {
      const previous = merged.at(-1)
      if (previous && interval.start - previous.end <= MAX_GAP_MS) {
        previous.end = Math.max(previous.end, interval.end)
      } else {
        merged.push({ ...interval })
      }
    }

    return merged
  }

  private async buildExportVideoContext(
    sourceSubtitles: SubtitlesFragment[],
    config: Config,
    operationId: number,
    pageTitle: string,
    providerRef: PromptableProviderRef | null,
  ): Promise<SubtitlesVideoContext> {
    const videoContext: SubtitlesVideoContext = {
      videoTitle: pageTitle,
      subtitlesTextContent: sourceSubtitles.map((fragment) => fragment.text).join(""),
    }
    const summaryContextHash = buildSubtitlesSummaryContextHash(
      videoContext,
      providerRef ?? undefined,
    )

    if (summaryContextHash) {
      try {
        videoContext.summary = await fetchSubtitlesSummary(
          videoContext,
          config,
          providerRef,
          this.taskFor(operationId),
        )
        this.assertActive(operationId)
      } catch {
        videoContext.summary = null
      }
    }

    return videoContext
  }
}
