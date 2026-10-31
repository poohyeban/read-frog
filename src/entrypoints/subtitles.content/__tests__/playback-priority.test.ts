import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { SegmentationPipeline } from "../segmentation-pipeline"
import { TranslationCoordinator } from "../translation-coordinator"
const model = vi.hoisted(() => ({
  translate: vi.fn<(...args: any[]) => any>(),
  segment: vi.fn<(...args: any[]) => any>(),
  events: [] as { type: string; lane?: string; starts: number[]; signal: AbortSignal }[],
}))
vi.mock("@/utils/subtitles/processor/translator", () => ({ translateSubtitles: model.translate }))
vi.mock("@/utils/subtitles/processor/ai-segmentation", () => ({ aiSegmentBlock: model.segment }))
vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
}))
class Player extends EventTarget {
  currentTime = 0
  playbackRate = 1
  seek(time: number) {
    this.currentTime = time
    this.dispatchEvent(new Event("seeking"))
    this.dispatchEvent(new Event("seeked"))
  }
}
const sessions: TranslationCoordinator[] = []
function setup(time = 0, overrides?: SubtitlesFragment[]) {
  const cues =
    overrides ??
    Array.from({ length: 1800 }, (_, i) => ({
      start: i * 2000,
      end: i * 2000 + 1800,
      text: `cue ${i}.`,
    }))
  const video = new Player()
  video.currentTime = time
  let coordinator: TranslationCoordinator
  const pipeline = new SegmentationPipeline({
    onChunkSegmented: () => coordinator?.noteFragmentListChanged(),
    rawFragments: cues,
    baselineFragments: cues,
    getVideoElement: () => video as unknown as HTMLVideoElement,
    getSourceLanguage: () => "en",
    providerRef: { kind: "local", config: {} as never },
  })
  const published: SubtitlesFragment[] = []
  coordinator = new TranslationCoordinator({
    configSnapshot: structuredClone(DEFAULT_CONFIG),
    getFragments: () => cues,
    getVideoElement: () => video as unknown as HTMLVideoElement,
    segmentationPipeline: pipeline,
    getCurrentState: () => "idle",
    onStateChange: () => {},
    onTranslated: (rows) => published.push(...rows),
  })
  sessions.push(coordinator)
  return { coordinator, pipeline, video, published }
}
beforeEach(() => {
  vi.useFakeTimers()
  model.events = []
  vi.clearAllMocks()
  const execute = (type: string, cues: SubtitlesFragment[], signal: AbortSignal, lane?: string) => {
    model.events.push({ type, lane, starts: cues.map((c) => c.start), signal })
    return new Promise<SubtitlesFragment[]>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            cues.map((c) => ({
              ...c,
              ...(type === "translate" ? { translation: `t:${c.text}` } : {}),
            })),
          ),
        type === "segment" ? 600 : 200,
      )
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(signal.reason)
        },
        { once: true },
      )
    })
  }
  model.translate.mockImplementation((cues, _context, _config, task) =>
    execute("translate", cues, task.signal, task.lane),
  )
  model.segment.mockImplementation((cues, _provider, task) => execute("segment", cues, task.signal))
})
afterEach(async () => {
  for (const coordinator of sessions.splice(0)) void coordinator.stop()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})
const flush = () => vi.advanceTimersByTimeAsync(0)

describe("playback position is the admission invariant", () => {
  it.each([0, 2120, 2400])(
    "starts at actual position %s without visiting historical windows",
    async (time) => {
      const { coordinator } = setup(time)
      coordinator.start()
      await flush()
      const translation = model.events.find((e) => e.type === "translate")!
      expect(translation.starts[0]).toBe(time * 1000)
      const segment = model.events.find((e) => e.type === "segment")!
      expect(
        segment.starts.some((start) => start <= time * 1000 && start + 1800 > time * 1000),
      ).toBe(true)
      expect(segment.starts[0]).toBeGreaterThanOrEqual(time > 0 ? 1 : 0)
      expect(model.events.filter((e) => e.type === "translate")).toHaveLength(2)
    },
  )
  it.each([
    [0, 2120],
    [300, 2400],
    [2400, 300],
  ])("reprioritizes %s→%s before old work completes", async (from, to) => {
    const { coordinator, video, published } = setup(from)
    coordinator.start()
    await flush()
    const previous = [...model.events]
    video.seek(to)
    await flush()
    expect(previous.every((event) => event.signal.aborted)).toBe(true)
    expect(model.events.filter((e) => e.type === "translate").at(-2)!.starts[0]).toBe(to * 1000)
    await vi.advanceTimersByTimeAsync(201)
    expect(published.some((c) => c.start === to * 1000)).toBe(true)
    expect(published.some((c) => c.start === from * 1000)).toBe(false)
  })
  it("coalesces rapid seek events and reuses pending identities for same-position ticks", async () => {
    const { coordinator, video } = setup(300)
    coordinator.start()
    await flush()
    video.seek(1200)
    video.seek(2120)
    video.seek(2400)
    await flush()
    const count = model.events.length
    expect(model.events.filter((e) => e.type === "translate").at(-2)!.starts[0]).toBe(2400000)
    for (let i = 0; i < 100; i++) video.dispatchEvent(new Event("timeupdate"))
    await flush()
    expect(model.events).toHaveLength(count)
    expect(model.events.some((e) => e.starts[0] === 1200000 || e.starts[0] === 2120000)).toBe(false)
  })
  it("includes a currently covering long cue in BOTH segmentation and translation", async () => {
    const long = { start: 2100000, end: 2140000, text: "Long sentence." }
    const { coordinator } = setup(2120, [long, { start: 2140000, end: 2142000, text: "Next." }])
    coordinator.start()
    await flush()
    for (const type of ["translate", "segment"])
      expect(model.events.find((e) => e.type === type)!.starts[0]).toBe(long.start)
  })
  it.each([2, 4])(
    "keeps bounded admission while prefetching at %sx and on playing/ratechange",
    async (rate) => {
      const { coordinator, video } = setup(2120)
      video.playbackRate = rate
      coordinator.start()
      await flush()
      expect(model.events.filter((e) => e.type === "translate")).toHaveLength(2)
      video.dispatchEvent(new Event("playing"))
      video.dispatchEvent(new Event("ratechange"))
      await flush()
      expect(model.events.filter((e) => e.type === "translate")).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1700)
      const starts = model.events.filter((e) => e.type === "translate").flatMap((e) => e.starts)
      expect(Math.max(...starts)).toBeLessThanOrEqual(2120000 + 60000 * rate)
      const fastStarts = model.events
        .filter((e) => e.type === "translate" && e.lane === "fast")
        .flatMap((e) => e.starts)
      expect(Math.max(...fastStarts)).toBeLessThanOrEqual(2120000 + 30000 * rate)
      expect(Math.max(...starts)).toBeGreaterThan(2120000 + 30000)
    },
  )
  it("does not conflate cues sharing a start timestamp", async () => {
    const { coordinator, published } = setup(0, [
      { start: 0, end: 2000, text: "Speaker A." },
      { start: 0, end: 3000, text: "Speaker B." },
    ])
    coordinator.start()
    await vi.advanceTimersByTimeAsync(201)
    expect(published.map((c) => c.text)).toEqual(
      expect.arrayContaining(["Speaker A.", "Speaker B."]),
    )
  })
  it("translates current and future Fast cues without waiting for the AI recut", async () => {
    const { coordinator, published } = setup(2120)
    coordinator.start()
    await vi.advanceTimersByTimeAsync(599)
    const requests = model.events.filter((e) => e.type === "translate")
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0]?.starts).toEqual([2120000, 2122000, 2124000, 2126000, 2128000])
    expect(published[0]?.start).toBe(2120000)
    await vi.advanceTimersByTimeAsync(201)
    expect(model.events.filter((e) => e.type === "translate").length).toBeGreaterThan(1)
  })
})
