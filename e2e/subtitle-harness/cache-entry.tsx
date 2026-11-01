import {
  currentSubtitleAtom,
  sourceTrackAtom,
  subtitlesStore,
} from "@/entrypoints/subtitles.content/atoms"
import { SubtitlesScheduler } from "@/entrypoints/subtitles.content/subtitles-scheduler"
import { TranslationCoordinator } from "@/entrypoints/subtitles.content/translation-coordinator"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { SubtitleSession } from "@/utils/subtitles/session"
import { model } from "./model"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
;(window as any).runSubtitleBenchmark = async () => {
  const samples = []
  model.usePhysical = true
  model.concurrency = 2
  for (const cacheMs of [0, 8, 40, 300, -1])
    for (const hit of [false, true])
      for (let sample = 0; sample < 20; sample++) {
        model.delay = 100
        model.reset()
        const source = Array.from({ length: 5400 }, (_, i) => ({
          start: i * 2000,
          end: i * 2000 + 1800,
          text: `Sentence ${i}.`,
        }))
        const video = document.createElement("video")
        const renderer = new SubtitlesScheduler({ videoElement: video })
        const session = new SubtitleSession()
        const started = performance.now()
        let firstVisible: number | undefined,
          firstConfirmed: number | undefined,
          cacheReads = 0
        const unsubscribe = subtitlesStore.sub(currentSubtitleAtom, () => {
          if (subtitlesStore.get(currentSubtitleAtom)?.translation && firstVisible === undefined)
            firstVisible = performance.now() - started
        })
        const engine = new TranslationCoordinator({
          session,
          configSnapshot: structuredClone(DEFAULT_CONFIG),
          getFragments: () => source,
          getVideoElement: () => video,
          getCurrentState: () => renderer.getState(),
          segmentationPipeline: null,
          candidateCache: {
            read: async () => {
              cacheReads++
              if (cacheMs < 0) return new Promise(() => {})
              await wait(cacheMs)
              return hit
                ? [
                    {
                      key: "mock",
                      trackKey: "mock",
                      lane: "quality" as const,
                      start: 0,
                      end: 300000,
                      cues: source
                        .slice(0, 150)
                        .map((c) => ({ ...c, translation: `Cached ${c.text}` })),
                      createdAt: new Date(),
                    },
                  ]
                : []
            },
            write: async () => {},
          },
          onStateChange: (state, data) => renderer.setState(state, data),
          onTranslated: (cues, lane) => {
            if (cues.some((c) => c.start === 0 && c.translation) && firstConfirmed === undefined)
              firstConfirmed = performance.now() - started
            renderer.supplementSubtitles(cues, lane)
          },
        })
        subtitlesStore.set(sourceTrackAtom, source)
        renderer.start()
        engine.start()
        await wait(600)
        await engine.stop()
        const stopped = performance.now()
        await wait(1)
        const events = [...model.events]
        samples.push({
          cacheMs,
          hit,
          sample,
          firstVisible,
          firstConfirmed,
          cacheReads,
          providerStart:
            (events.find((e) => e.type === "translate:execute")?.at ?? NaN) - started || null,
          requests: events.filter((e) => e.type.endsWith(":execute")).length,
          cancelled: events.filter((e) => e.type.endsWith(":cancel")).length,
          afterStopRequests: events.filter((e) => e.type.endsWith(":execute") && e.at > stopped)
            .length,
          peakActive: model.peakActive,
          concurrency: model.concurrency,
        })
        unsubscribe()
        renderer.stop()
        renderer.reset()
        session.dispose()
      }
  return {
    samples,
    checks: {
      visible: samples.every((s) => s.firstVisible !== undefined),
      oneCacheRead: samples.every((s) => s.cacheReads === 1),
    },
    note: "Mock processor + real Chromium coordinator, renderer and physical scheduler; virtual latency, no HTTP or billed tokens. CDP CPU/heap are real measurements.",
  }
}
