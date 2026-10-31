import { sourceTrackAtom, subtitlesStore } from "@/entrypoints/subtitles.content/atoms"
import { SegmentationPipeline } from "@/entrypoints/subtitles.content/segmentation-pipeline"
import { SubtitlesScheduler } from "@/entrypoints/subtitles.content/subtitles-scheduler"
import { TranslationCoordinator } from "@/entrypoints/subtitles.content/translation-coordinator"
import { SubtitleSession } from "@/utils/subtitles/session"
import { model } from "./model"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
;(window as any).runSubtitleBenchmark = async () => {
  model.usePhysical = true
  model.concurrency = 2
  model.delay = 1000
  model.segmentDelay = 15000
  model.reset()
  const source = Array.from({ length: 5400 }, (_, i) => ({
    start: i * 2000,
    end: i * 2000 + 1800,
    text: `Sentence ${i}.`,
  }))
  const video = document.createElement("video")
  let time = 0
  Object.defineProperty(video, "currentTime", {
    get: () => time,
    set: (value) => {
      time = value
    },
  })
  video.playbackRate = 4
  const renderer = new SubtitlesScheduler({ videoElement: video })
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
  engine = new TranslationCoordinator({
    session,
    getFragments: () => source,
    getVideoElement: () => video,
    getConcurrency: async () => 2,
    getCurrentState: () => renderer.getState(),
    segmentationPipeline: pipeline,
    onStateChange: (state, data) => renderer.setState(state, data),
    onTranslated: (cues, lane) => renderer.supplementSubtitles(cues, lane),
  })
  subtitlesStore.set(sourceTrackAtom, source)
  renderer.start()
  const stamp = Date.now()
  engine.start()
  for (let i = 0; i < 100; i++) {
    video.currentTime = ((i * 7919) % 5300) * 2
    video.dispatchEvent(new Event("seeking"))
    video.dispatchEvent(new Event("seeked"))
    await wait(100)
  }
  await engine.stop()
  const seeks = model.resource!.inspect()
  const count = () => model.events.filter((event) => event.type.endsWith(":execute")).length
  const seekRequests = count()
  const rateBound = 20 + Math.floor(((Date.now() - stamp) / 1000) * 8)
  await wait(1000)
  const afterStopRequests = count() - seekRequests
  for (let cycle = 0; cycle < 100; cycle++) {
    engine.start()
    await wait(1)
    await engine.stop()
  }
  const stopped = count()
  video.currentTime = 0
  video.dispatchEvent(new Event("seeking"))
  await wait(30000)
  const checks = {
    seekRateBound: seekRequests <= rateBound,
    concurrencyBound: model.peakActive <= 2,
    boundedCues: model.events.every((event) => (event.count ?? 0) <= 32),
    stoppedZeroRequests: afterStopRequests === 0 && count() === stopped,
    noActive: model.resource!.inspect().active === 0,
    noQueued: model.resource!.inspect().queued === 0,
    noTimers: model.resource!.inspect().timers === 0,
  }
  session.dispose()
  renderer.stop()
  renderer.reset()
  return {
    checks,
    seekRequests,
    rateBound,
    stopStartRequests: stopped - seekRequests,
    afterStopRequests,
    seeks,
    finalResources: model.resource!.inspect(),
    requests: count(),
    retries: model.retries,
    cancelled: model.events.filter((event) => event.type.endsWith(":cancel")).length,
    estimatedInputTokens: model.estimatedTokens,
    realUsage: null,
    note: "3h source, 4x, 100 separated random seeks, then 100 stop/start cycles. Actual coordinator/segmentation/ResourceScheduler with local Mock Provider; virtual time.",
  }
}
