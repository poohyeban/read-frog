import { Provider, useAtomValue } from "jotai"
import React, { useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import {
  currentTimeMsAtom,
  displaySubtitleAtom,
  sourceTrackAtom,
  subtitlesStore,
} from "@/entrypoints/subtitles.content/atoms"
import { SegmentationPipeline } from "@/entrypoints/subtitles.content/segmentation-pipeline"
import { SubtitlesScheduler } from "@/entrypoints/subtitles.content/subtitles-scheduler"
import { TranslationCoordinator } from "@/entrypoints/subtitles.content/translation-coordinator"
import { model } from "./model"
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const makeCues = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    start: i * 2000,
    end: i * 2000 + 1800,
    text: `Sentence ${i}.`,
  }))
function videoAt(time: number) {
  const video = document.createElement("video")
  let value = time
  Object.defineProperty(video, "currentTime", {
    get: () => value,
    set: (next) => {
      value = next
    },
  })
  return video
}
let commits = 0
function Caption() {
  const cue = useAtomValue(displaySubtitleAtom)
  useLayoutEffect(() => {
    commits++
  })
  return <span>{cue?.text}</span>
}
const root = createRoot(document.getElementById("root")!)
root.render(
  <Provider store={subtitlesStore}>
    <Caption />
  </Provider>,
)
;(window as any).runSubtitleBenchmark = async () => {
  const scales = []
  for (const size of [100, 1000, 10000, 50000]) {
    const cues = makeCues(size)
    subtitlesStore.set(sourceTrackAtom, cues)
    const video = videoAt(0)
    const scheduler = new SubtitlesScheduler({ videoElement: video })
    scheduler.start()
    const lookup = [],
      updates = [],
      bulk = []
    for (let sample = 0; sample < 30; sample++) {
      let stamp = performance.now()
      for (let i = 0; i < 200; i++) {
        const index = ((sample * 200 + i) * 7919) % size
        subtitlesStore.set(currentTimeMsAtom, cues[index]!.start + 100)
        subtitlesStore.get(displaySubtitleAtom)
      }
      lookup.push((performance.now() - stamp) / 200)
      stamp = performance.now()
      for (let i = 0; i < 200; i++) {
        video.currentTime = (((sample * 200 + i) * 7919) % size) * 2 + 0.1
        video.dispatchEvent(new Event("timeupdate"))
      }
      updates.push((performance.now() - stamp) / 200)
    }
    scheduler.supplementSubtitles(cues.map((f) => ({ ...f, translation: f.text })))
    for (let sample = 0; sample < 10; sample++) {
      const stamp = performance.now()
      scheduler.supplementSubtitles(
        cues
          .slice(-Math.min(size, 500))
          .map((f) => ({ ...f, translation: `${sample}: ${f.text}` })),
      )
      bulk.push(performance.now() - stamp)
    }
    subtitlesStore.set(currentTimeMsAtom, 100)
    await delay(10)
    const initialCommits = commits
    for (let i = 0; i < 30; i++) {
      subtitlesStore.set(currentTimeMsAtom, 100 + i)
      await delay(1)
    }
    scales.push({
      size,
      lookup,
      timeupdate: updates,
      bulk500: bulk,
      sameCueCommits: commits - initialCommits,
      heapBytes: (performance as any).memory?.usedJSHeapSize,
    })
    scheduler.reset()
    scheduler.stop()
  }
  const scenarios = []
  const cases = [
    "zero",
    "resume2120",
    "asyncResume",
    "link2400",
    "seekForward",
    "seekBackward",
    "longCue",
    "pauseResume",
    "rate2",
    "rate4",
    "rapidSeek",
    "stopStart",
  ]
  for (let sample = 0; sample < 30; sample++)
    for (const name of cases) {
      const cues = makeCues(1800)
      if (name === "longCue")
        cues.splice(1050, 20, {
          start: 2100000,
          end: 2140000,
          text: "Long subtitle spanning the restored position.",
        })
      const initial = ["resume2120", "longCue", "pauseResume", "rate2", "rate4"].includes(name)
        ? 2120
        : name === "link2400" || name === "seekBackward"
          ? 2400
          : name === "seekForward" || name === "rapidSeek"
            ? 300
            : 0
      const video = videoAt(initial)
      if (name === "rate2") video.playbackRate = 2
      if (name === "rate4") video.playbackRate = 4
      model.reset()
      let state: any = "idle"
      let coordinator: TranslationCoordinator | undefined
      const pipeline = new SegmentationPipeline({
        onChunkSegmented: () => coordinator?.noteFragmentListChanged(),
        baselineFragments: cues,
        rawFragments: cues,
        getVideoElement: () => video,
        getSourceLanguage: () => "en",
        providerRef: { kind: "local", config: {} } as any,
      })
      const published: any[] = []
      const readyCues = new Set<string>()
      const cueKey = (cue: any) => JSON.stringify([cue.start, cue.end, cue.text])
      coordinator = new TranslationCoordinator({
        getFragments: () => pipeline.processedFragments,
        getVideoElement: () => video,
        getCurrentState: () => state,
        segmentationPipeline: pipeline,
        onTranslated: (rows) => {
          for (const cue of rows) readyCues.add(cueKey(cue))
          published.push({
            at: performance.now(),
            starts: rows.map((f) => f.start),
            ends: rows.map((f) => f.end),
          })
        },
        onStateChange: (next) => {
          state = next
        },
      })
      const started = performance.now()
      coordinator.start({ videoTitle: "fixture", subtitlesTextContent: "fixture" })
      await delay(5)
      const seek = (time: number) => {
        video.currentTime = time
        video.dispatchEvent(new Event("seeking"))
        video.dispatchEvent(new Event("seeked"))
      }
      const changedAt = performance.now()
      if (name === "asyncResume") seek(2120)
      if (name === "seekForward") seek(2400)
      if (name === "seekBackward") seek(300)
      if (name === "rapidSeek") {
        seek(1200)
        seek(2120)
        seek(2400)
      }
      if (name === "stopStart") {
        coordinator.stop()
        coordinator.start()
      }
      if (name === "pauseResume") video.dispatchEvent(new Event("playing"))
      const targetTimeMs = video.currentTime * 1000
      const readiness: boolean[] = []
      if (name === "rate2" || name === "rate4") {
        for (let frame = 0; frame < 20; frame++) {
          await delay(50)
          video.currentTime += 0.05 * video.playbackRate
          video.dispatchEvent(new Event("timeupdate"))
          const current = pipeline.processedFragments.find(
            (cue) => cue.start <= video.currentTime * 1000 && cue.end > video.currentTime * 1000,
          )
          if (current) readiness.push(readyCues.has(cueKey(current)))
        }
      } else await delay(250)
      coordinator.stop()
      const stopped = performance.now()
      await delay(80)
      scenarios.push({
        name,
        sample,
        started,
        changedAt,
        targetTimeMs,
        readiness,
        stopped,
        events: [...model.events],
        published,
      })
    }
  return { scales, scenarios }
}
