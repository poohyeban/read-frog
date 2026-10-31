import {
  currentSubtitleAtom,
  sourceTrackAtom,
  subtitlesStore,
} from "@/entrypoints/subtitles.content/atoms"
import { SegmentationPipeline } from "@/entrypoints/subtitles.content/segmentation-pipeline"
import { SubtitlesScheduler } from "@/entrypoints/subtitles.content/subtitles-scheduler"
import { TranslationCoordinator } from "@/entrypoints/subtitles.content/translation-coordinator"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { SubtitleSession } from "@/utils/subtitles/session"
import { model } from "./model"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

;(window as any).runSubtitleBenchmark = async () => {
  const samples = []
  model.usePhysical = true
  const cases: {
    rate: number
    concurrency: number
    latency: number
    density: number
    mode: string
    failure: string
    requestRate?: number
    burst?: number
  }[] = []
  for (const rate of [1, 2, 4])
    for (const concurrency of [1, 2, 4, 8])
      for (const latency of [100, 1000, 3000, 8000, 15000, 30000])
        for (const density of [1, 4])
          cases.push({ rate, concurrency, latency, density, mode: "dual", failure: "" })
  for (const rate of [1, 2, 4])
    for (const mode of ["fast", "quality-cache"])
      cases.push({ rate, concurrency: 2, latency: 1000, density: 1, mode, failure: "" })
  for (const failure of ["429", "timeout", "401"])
    cases.push({ rate: 2, concurrency: 1, latency: 1000, density: 1, mode: "dual", failure })
  for (const requestRate of [1, 4, 8, 16])
    for (const burst of [1, 4, 20])
      cases.push({
        rate: 4,
        concurrency: 2,
        latency: 100,
        density: 4,
        mode: "dual",
        failure: "",
        requestRate,
        burst,
      })
  for (const test of cases) {
    ;(window as any).__matrixProgress = { completed: samples.length, total: cases.length, test }
    model.requestRate = test.requestRate ?? 8
    model.burst = test.burst ?? 20
    model.concurrency = test.concurrency
    model.delay = test.latency
    model.segmentDelay = Math.max(15000, test.latency)
    model.failure = test.failure
    model.reset()
    const interval = 2000 / test.density
    const source = Array.from({ length: 10800000 / interval }, (_, index) => ({
      start: index * interval,
      end: index * interval + interval * 0.9,
      text: `Sentence ${index}.`,
    }))
    const video = document.createElement("video")
    let time = 5400
    Object.defineProperty(video, "currentTime", {
      get: () => time,
      set: (value) => {
        time = value
      },
    })
    video.playbackRate = test.rate
    const renderer = new SubtitlesScheduler({ videoElement: video })
    const started = performance.now()
    const completed: { start: number; end: number; at: number }[] = []
    let engine: TranslationCoordinator
    const session = new SubtitleSession()
    const pipeline = new SegmentationPipeline({
      session,
      rawFragments: source,
      getVideoElement: () => video,
      getSourceLanguage: () => "en",
      providerRef: { kind: "local", config: {} } as never,
      onChunkSegmented: () => engine.noteFragmentListChanged(),
    })
    let cacheHits = 0
    engine = new TranslationCoordinator({
      session,
      configSnapshot: structuredClone(DEFAULT_CONFIG),
      getConcurrency: async () => test.concurrency,
      getFragments: () => source,
      getVideoElement: () => video,
      getCurrentState: () => renderer.getState(),
      segmentationPipeline: test.mode === "dual" ? pipeline : null,
      candidateCache:
        test.mode === "quality-cache"
          ? {
              read: async () => {
                cacheHits++
                return [
                  {
                    key: "warm",
                    trackKey: "track",
                    lane: "quality",
                    start: 5340000,
                    end: 5640000,
                    createdAt: new Date(),
                    cues: source
                      .filter((c) => c.start >= 5340000 && c.end <= 5640000)
                      .map((c) => ({ ...c, translation: `cached ${c.text}` })),
                  },
                ]
              },
              write: async () => {},
            }
          : undefined,
      onStateChange: (state, data) => renderer.setState(state, data),
      onTranslated: (cues, lane) => {
        for (const cue of cues)
          if (cue.translation?.trim())
            completed.push({ start: cue.start, end: cue.end, at: performance.now() - started })
        renderer.supplementSubtitles(cues, lane)
      },
    })
    subtitlesStore.set(sourceTrackAtom, source)
    renderer.start()
    engine.start()
    const deadlines: { at: number | null; deadline: number }[] = []
    const visited = new Set<number>()
    for (let frame = 0; frame < 120; frame++) {
      await wait(250)
      video.currentTime = 5400 + (frame + 1) * 0.25 * test.rate
      video.dispatchEvent(new Event("timeupdate"))
      const index = Math.floor((video.currentTime * 1000 - 5400000) / interval)
      if (!visited.has(index)) {
        visited.add(index)
        const current = completed.find(
          (c) => c.start <= 5400000 + index * interval && c.end > 5400000 + index * interval,
        )
        deadlines.push({ at: current?.at ?? null, deadline: (index * interval) / test.rate })
      }
    }
    const requests = () => model.events.filter((e) => e.type.endsWith(":execute")).length
    const beforeReplay = requests()
    video.currentTime = 5400
    video.dispatchEvent(new Event("seeking"))
    video.dispatchEvent(new Event("seeked"))
    const replayReady = !!subtitlesStore.get(currentSubtitleAtom)?.translation
    await wait(1)
    const replayNewRequests = requests() - beforeReplay
    await engine.stop()
    const beforeStop = requests()
    for (let i = 0; i < 100; i++) video.dispatchEvent(new Event("timeupdate"))
    await wait(1)
    samples.push({
      ...test,
      firstMs: completed.find((c) => c.start <= 5400000 && c.end > 5400000)?.at ?? null,
      readyBeforeDisplay:
        deadlines.filter((d) => d.at !== null && d.at <= d.deadline).length / deadlines.length,
      readyAhead: Object.fromEntries(
        [2, 3, 5].map((seconds) => [
          seconds,
          deadlines.filter((d) => d.at !== null && d.at <= d.deadline - seconds * 1000).length /
            deadlines.length,
        ]),
      ),
      requests: requests(),
      retries: model.retries,
      cancelled: model.events.filter((e) => e.type.endsWith(":cancel")).length,
      cacheHits,
      estimatedInputTokens: model.estimatedTokens,
      realUsage: null,
      peakActive: model.peakActive,
      replayReady,
      replayNewRequests,
      afterStopRequests: requests() - beforeStop,
      maxAttempts: Math.max(0, ...model.attempts.values()),
      resources: model.resource?.inspect(),
      heapBytes: (performance as any).memory.usedJSHeapSize,
    })
    renderer.stop()
    renderer.reset()
    session.dispose()
  }
  return {
    samples,
    clock: "virtual time",
    note: "Actual coordinator and actual baseline RequestQueue/ExecutionSlots or new RequestQueue/ResourceScheduler around a local Mock Provider. Input tokens are conservative estimates; real usage unavailable. No paid requests.",
  }
}
