import {
  currentSubtitleAtom,
  sourceTrackAtom,
  subtitlesStore,
} from "@/entrypoints/subtitles.content/atoms"
import { SegmentationPipeline } from "@/entrypoints/subtitles.content/segmentation-pipeline"
import { SubtitlesScheduler } from "@/entrypoints/subtitles.content/subtitles-scheduler"
import { TranslationCoordinator } from "@/entrypoints/subtitles.content/translation-coordinator"
import { model } from "./model"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
;(window as any).runSubtitleBenchmark = async () => {
  const samples = []
  const mode = (window as any).__benchmarkMode ?? "dual"
  model.delay = 1000
  model.segmentDelay = 15000
  for (const rate of [1, 2, 4])
    for (let sample = 0; sample < 30; sample++) {
      model.reset()
      const source = Array.from({ length: 5400 }, (_, i) => ({
        start: i * 2000,
        end: i * 2000 + 1800,
        text: `Sentence ${i}.`,
      }))
      const video = document.createElement("video")
      let time = 5400
      Object.defineProperty(video, "currentTime", {
        get: () => time,
        set: (next) => {
          time = next
        },
      })
      video.playbackRate = rate
      const scheduler = new SubtitlesScheduler({ videoElement: video })
      let engine: TranslationCoordinator
      const pipeline = new SegmentationPipeline({
        baselineFragments: source,
        rawFragments: source,
        getVideoElement: () => video,
        getSourceLanguage: () => "en",
        providerRef: { kind: "local", config: {} } as any,
        onChunkSegmented: () => engine.noteFragmentListChanged(),
      })
      const started = performance.now(),
        completed: { start: number; end: number; at: number }[] = []
      const readyTime = (mediaTime: number) =>
        completed.find((c) => c.start <= mediaTime && c.end > mediaTime)?.at
      engine = new TranslationCoordinator({
        getFragments: () => ((pipeline as any).setAdmission ? source : pipeline.processedFragments),
        getVideoElement: () => video,
        getCurrentState: () => scheduler.getState(),
        segmentationPipeline: mode === "dual" ? pipeline : null,
        candidateCache:
          mode === "quality-cache"
            ? {
                read: async () => [
                  {
                    key: "warm-fixture",
                    trackKey: "fixture",
                    lane: "quality" as const,
                    cues: source
                      .filter((cue) => cue.start >= 5400000 && cue.end <= 5700000)
                      .map((cue) => ({ ...cue, translation: `cached ${cue.text}` })),
                    start: 5400000,
                    end: 5700000,
                    createdAt: new Date(),
                  },
                ],
                write: async () => {},
              }
            : undefined,
        onStateChange: (state, data) => scheduler.setState(state, data),
        onTranslated: (cues, lane) => {
          for (const cue of cues)
            if (cue.translation?.trim())
              completed.push({ start: cue.start, end: cue.end, at: performance.now() - started })
          scheduler.supplementSubtitles(cues, lane)
        },
      })
      subtitlesStore.set(sourceTrackAtom, source)
      scheduler.start()
      engine.start()
      const beforeDisplay: {
        index: number
        ready: boolean
        translatedAtMs: number | null
        deadlineMs: number
      }[] = []
      const visited = new Set<number>()
      for (let frame = 0; frame < 120; frame++) {
        await delay(500)
        video.currentTime = 5400 + (frame + 1) * 0.5 * rate
        video.dispatchEvent(new Event("timeupdate"))
        const index = Math.floor((video.currentTime - 5400) / 2)
        if (!visited.has(index)) {
          visited.add(index)
          const at = readyTime(5400000 + index * 2000)
          const deadline = (index * 2000) / rate
          beforeDisplay.push({
            index: index + 1,
            ready: at !== undefined && at <= deadline,
            translatedAtMs: at ?? null,
            deadlineMs: deadline,
          })
        }
      }
      const callsBeforeReplay = model.events.filter((e) => e.type.endsWith(":execute")).length
      video.currentTime = 5400
      video.dispatchEvent(new Event("seeking"))
      video.dispatchEvent(new Event("seeked"))
      const replayImmediate = !!subtitlesStore.get(currentSubtitleAtom)?.translation
      await delay(1)
      const replayNewTasks =
        model.events.filter((e) => e.type.endsWith(":execute")).length - callsBeforeReplay
      await engine.stop()
      const stopped = performance.now()
      await delay(1)
      const events = [...model.events]
      samples.push({
        rate,
        sample,
        translationMs: 1000,
        segmentationMs: 15000,
        readyAt: Object.fromEntries(
          [1, 2, 3, 5, 10].map((n) => [n, readyTime(5400000 + (n - 1) * 2000) ?? null]),
        ),
        beforeDisplay,
        replayImmediate,
        replayNewTasks,
        requests: events.filter((e) => e.type.endsWith(":execute")).length,
        completed: events.filter((e) => e.type.endsWith(":complete")).length,
        cancelled: events.filter((e) => e.type.endsWith(":cancel")).length,
        afterStopRequests: events.filter((e) => e.type.endsWith(":execute") && e.at > stopped)
          .length,
      })
      scheduler.stop()
      scheduler.reset()
    }
  return {
    mode,
    clock: "Playwright virtual clock; actual engine classes and deterministic Mock Provider",
    samples,
    note: "Requests count mocked processor invocations, not paid API calls. Real Provider usage is unavailable. Atomic API budgets are tested separately through the SDK and IndexedDB harness.",
  }
}
