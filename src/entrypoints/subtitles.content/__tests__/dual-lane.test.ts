import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { currentSubtitleAtom, sourceTrackAtom, subtitlesStore, translatedTrackAtom } from "../atoms"
import { SegmentationPipeline } from "../segmentation-pipeline"
import { SubtitlesScheduler } from "../subtitles-scheduler"
import { TranslationCoordinator } from "../translation-coordinator"

const model = vi.hoisted(() => ({
  translate: vi.fn<(...args: any[]) => any>(),
  segment: vi.fn<(...args: any[]) => any>(),
  segmentDelay: 15000,
  translationDelay: 1000,
  calls: [] as { lane: string; start: number; at: number }[],
}))
vi.mock("@/utils/subtitles/processor/translator", () => ({
  translateSubtitles: model.translate,
  fetchSubtitlesSummary: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/subtitles/processor/ai-segmentation", () => ({ aiSegmentBlock: model.segment }))
vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
}))

class Player extends EventTarget {
  currentTime = 5400
  playbackRate = 1
  paused = false
  seek(time: number) {
    this.currentTime = time
    this.dispatchEvent(new Event("seeking"))
  }
}
const instances: { engine: TranslationCoordinator; renderer: SubtitlesScheduler }[] = []
function setup(rate = 1) {
  const source = Array.from({ length: 5400 }, (_, i) => ({
    start: i * 2000,
    end: i * 2000 + 1800,
    text: `Cue ${i}.`,
  }))
  const video = new Player()
  video.playbackRate = rate
  const renderer = new SubtitlesScheduler({ videoElement: video as unknown as HTMLVideoElement })
  let engine: TranslationCoordinator
  const pipeline = new SegmentationPipeline({
    rawFragments: source,
    baselineFragments: source,
    getVideoElement: () => video as unknown as HTMLVideoElement,
    getSourceLanguage: () => "en",
    providerRef: { kind: "local", config: {} as never },
    onChunkSegmented: () => engine.noteFragmentListChanged(),
  })
  engine = new TranslationCoordinator({
    configSnapshot: structuredClone(DEFAULT_CONFIG),
    getFragments: () => source,
    getVideoElement: () => video as unknown as HTMLVideoElement,
    getCurrentState: () => renderer.getState(),
    segmentationPipeline: pipeline,
    onTranslated: (cues, lane) => renderer.supplementSubtitles(cues, lane),
    onStateChange: (state) => renderer.setState(state),
  })
  subtitlesStore.set(sourceTrackAtom, source)
  renderer.start()
  engine.start()
  instances.push({ engine, renderer })
  return { engine, renderer, video, source }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  model.calls = []
  model.segmentDelay = 15000
  model.translationDelay = 1000
  subtitlesStore.set(currentSubtitleAtom, null)
  subtitlesStore.set(translatedTrackAtom, [])
  const run = (lane: string, cues: SubtitlesFragment[], task: any, delay: number) => {
    model.calls.push({ lane, start: cues[0]!.start, at: Date.now() })
    return new Promise<SubtitlesFragment[]>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            lane === "segmentation"
              ? cues.flatMap((cue, i) =>
                  i % 2 === 0
                    ? [
                        {
                          start: cue.start,
                          end: cues[i + 1]?.end ?? cue.end,
                          text: `${cue.text} ${cues[i + 1]?.text ?? ""}`,
                        },
                      ]
                    : [],
                )
              : cues.map((cue) => ({
                  ...cue,
                  translation: `${lane}:${cue.text}`,
                  translationOutcome: { status: "success" as const },
                })),
          ),
        delay,
      )
      task.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(task.signal.reason)
        },
        { once: true },
      )
    })
  }
  model.translate.mockImplementation((cues, _context, _config, task) =>
    run(task.lane, cues, task, model.translationDelay),
  )
  model.segment.mockImplementation((cues, _provider, task) =>
    run("segmentation", cues, task, model.segmentDelay),
  )
})
afterEach(async () => {
  for (const { engine, renderer } of instances.splice(0)) {
    await engine.stop()
    renderer.stop()
    renderer.reset()
  }
  vi.useRealTimers()
})
describe("three-hour independent dual lanes", () => {
  it.each([1, 2, 4])(
    "prepares future Fast captions while 15s segmentation runs at %sx",
    async (rate) => {
      const { video } = setup(rate)
      await vi.advanceTimersByTimeAsync(1100)
      const ready = subtitlesStore.get(translatedTrackAtom)
      for (const index of [1, 2, 4])
        expect(ready.some((c) => c.start === 5_400_000 + index * 2000)).toBe(true)
      expect(model.calls.some((c) => c.lane === "segmentation")).toBe(true)
      expect(
        model.calls
          .filter((c) => c.lane === "fast")
          .every((c) => c.start >= video.currentTime * 1000),
      ).toBe(true)
      expect(model.calls.length).toBeLessThan(10)
    },
  )
  it.each([100, 1000, 3000, 8000, 15000, 30000])(
    "bounds paused pre-read with a %d ms translation provider",
    async (latency) => {
      model.translationDelay = latency
      const { engine } = setup()
      await vi.advanceTimersByTimeAsync(latency + 100)
      const ready = subtitlesStore.get(translatedTrackAtom)
      for (const index of [1, 2, 4])
        expect(
          ready.some((c) => c.start <= 5400000 + index * 2000 && c.end > 5400000 + index * 2000),
        ).toBe(true)
      await vi.advanceTimersByTimeAsync(120000)
      expect(model.calls.length).toBeLessThan(40)
      await engine.stop()
    },
  )
  it("100 stop/start cycles leave zero task timers and balanced video listeners", async () => {
    const { engine, video, renderer } = setup()
    await engine.stop()
    renderer.stop()
    const add = vi.spyOn(video, "addEventListener"),
      remove = vi.spyOn(video, "removeEventListener")
    for (let i = 0; i < 100; i++) {
      engine.start()
      await vi.advanceTimersByTimeAsync(0)
      await engine.stop()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(add).toHaveBeenCalledTimes(700)
    expect(remove).toHaveBeenCalledTimes(700)
    expect(vi.getTimerCount()).toBe(0)
    expect(model.calls.length).toBeLessThanOrEqual(300)
  })
  it("keeps Fast available with a thirty-second Quality provider", async () => {
    model.segmentDelay = 30000
    const { engine } = setup()
    await vi.advanceTimersByTimeAsync(2000)
    expect(subtitlesStore.get(currentSubtitleAtom)?.translation).toMatch(/^fast:/)
    expect(model.calls.length).toBeLessThan(12)
    await engine.stop()
  })
  it("switches at different boundaries and reselects historical Quality without new requests", async () => {
    const { video, source } = setup()
    await vi.advanceTimersByTimeAsync(1100)
    expect(subtitlesStore.get(currentSubtitleAtom)?.translation).toMatch(/^fast:/)
    video.seek(5403)
    await vi.advanceTimersByTimeAsync(16000)
    expect(subtitlesStore.get(sourceTrackAtom)).toEqual(source)
    const quality = subtitlesStore.get(currentSubtitleAtom)
    expect(quality?.translation).toMatch(/^quality:/)
    expect(quality?.start).toBe(5_400_000)
    expect(quality?.translation).toBe(`quality:${quality?.text}`)
    video.seek(5410)
    await vi.advanceTimersByTimeAsync(2000)
    const before = model.calls.length
    video.seek(5400)
    expect(subtitlesStore.get(currentSubtitleAtom)?.translation).toMatch(/^quality:/)
    await vi.advanceTimersByTimeAsync(1)
    expect(model.calls.length).toBe(before)
  })
  it("hydrates historical Quality before considering new requests after refresh", async () => {
    const source = [
      { start: 0, end: 2000, text: "one" },
      { start: 2000, end: 4000, text: "two" },
    ]
    const quality = [{ start: 0, end: 4000, text: "one two", translation: "cached quality" }]
    const video = new Player()
    video.currentTime = 1
    const renderer = new SubtitlesScheduler({ videoElement: video as unknown as HTMLVideoElement })
    const engine = new TranslationCoordinator({
      configSnapshot: structuredClone(DEFAULT_CONFIG),
      getFragments: () => source,
      getVideoElement: () => video as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onStateChange: () => {},
      onTranslated: (cues, lane) => renderer.supplementSubtitles(cues, lane),
      candidateCache: {
        read: async () => [
          {
            key: "bundle",
            trackKey: "track",
            lane: "quality",
            cues: quality,
            start: 0,
            end: 4000,
            createdAt: new Date(),
          },
        ],
        write: async () => {},
      },
    })
    instances.push({ engine, renderer })
    renderer.start()
    engine.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(subtitlesStore.get(currentSubtitleAtom)?.translation).toBe("cached quality")
    expect(model.calls).toHaveLength(0)
    await engine.stop()
    engine.start()
    video.seek(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(model.calls).toHaveLength(0)
  })
  it("a sufficient Quality buffer stops new speculative Fast requests", async () => {
    const { video, engine } = setup()
    await vi.advanceTimersByTimeAsync(18000)
    const before = model.calls.filter((c) => c.lane === "fast").length
    for (let i = 0; i < 20; i++) {
      video.currentTime = 5400 + i * 0.2
      video.dispatchEvent(new Event("timeupdate"))
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(model.calls.filter((c) => c.lane === "fast")).toHaveLength(before)
    await engine.stop()
  })
  it("100 same-turn seeks coalesce and stop acknowledgement permits zero new calls", async () => {
    const { video, engine } = setup()
    for (let i = 0; i < 100; i++) video.seek(1000 + i * 20)
    await vi.advanceTimersByTimeAsync(1)
    expect(model.calls.length).toBeLessThanOrEqual(3)
    await engine.stop()
    const before = model.calls.length
    for (let i = 0; i < 100; i++) video.seek(i * 20)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(model.calls.length).toBe(before)
  })
})
