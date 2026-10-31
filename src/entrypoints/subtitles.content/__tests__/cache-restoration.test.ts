import type { SegmentationPipeline } from "../segmentation-pipeline"
import type { SubtitleCandidateBundle, SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { SUBTITLE_PERFORMANCE_DEFAULTS } from "@/utils/request/resource-policy"
import { SubtitleSession } from "@/utils/subtitles/session"
import { TranslationCoordinator } from "../translation-coordinator"

const mock = vi.hoisted(() => ({ translate: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/subtitles/processor/translator", () => ({
  translateSubtitles: mock.translate,
  fetchSubtitlesSummary: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const instances: { engine: TranslationCoordinator; session: SubtitleSession }[] = []
function setup(
  read: (start: number, end: number, signal?: AbortSignal) => Promise<SubtitleCandidateBundle[]>,
  canRequest = true,
  quality = false,
) {
  const source = Array.from({ length: 5400 }, (_, i) => ({
    start: i * 2000,
    end: (i + 1) * 2000,
    text: `cue-${i}`,
  }))
  const video = Object.assign(new EventTarget(), { currentTime: 0, playbackRate: 1, paused: false })
  const session = new SubtitleSession()
  const publish = vi.fn<(...args: any[]) => any>()
  const engine = new TranslationCoordinator({
    session,
    configSnapshot: structuredClone(DEFAULT_CONFIG),
    getFragments: () => source,
    getVideoElement: () => video as HTMLVideoElement,
    getCurrentState: () => "idle",
    segmentationPipeline: quality
      ? ({
          processedFragments: source,
          setAdmission: () => {},
          setLatencyObserver: () => {},
          reprioritize: () => {},
          stop: () => {},
          restore: () => {},
        } as unknown as SegmentationPipeline)
      : null,
    candidateCache: { read, write: async () => {} },
    canRequest: () => canRequest,
    onTranslated: publish,
    onStateChange: () => {},
  })
  instances.push({ engine, session })
  engine.start()
  return { engine, session, video, source, publish }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mock.translate.mockImplementation(async (cues: SubtitlesFragment[]) =>
    cues.map((cue) => ({ ...cue, translation: "translated" })),
  )
})
afterEach(async () => {
  for (const { engine, session } of instances.splice(0)) {
    await engine.stop()
    session.dispose()
  }
  vi.useRealTimers()
})

it("bounds a hung read, continues Fast, and never fans out cache reads over 100 seeks/stop-starts", async () => {
  const read = vi.fn<() => Promise<SubtitleCandidateBundle[]>>(() => new Promise(() => {}))
  const { engine, video, session } = setup(read, true, true)
  await vi.advanceTimersByTimeAsync(500)
  expect(mock.translate).toHaveBeenCalled()
  expect(new Set(mock.translate.mock.calls.map((call) => call[3].lane))).toEqual(
    new Set(["fast", "quality"]),
  )
  for (let i = 0; i < 100; i++) {
    video.currentTime = i * 100
    video.dispatchEvent(new Event("seeking"))
    await vi.advanceTimersByTimeAsync(1)
    await engine.stop()
    engine.start()
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(read).toHaveBeenCalledTimes(1)
  await engine.stop()
  const starts = mock.translate.mock.calls.length
  await vi.advanceTimersByTimeAsync(60000)
  expect(mock.translate).toHaveBeenCalledTimes(starts)
  expect(session.taskCount).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["rejection", "sync throw"])(
  "continues on cache %s and cools repeated failed lookups",
  async (mode) => {
    const read = vi.fn<() => Promise<SubtitleCandidateBundle[]>>(() => {
      if (mode === "sync throw") throw new Error("DB unavailable")
      return Promise.reject(new Error("background unavailable"))
    })
    const { video } = setup(read)
    await vi.advanceTimersByTimeAsync(1)
    expect(mock.translate).toHaveBeenCalled()
    for (let i = 1; i <= 100; i++) {
      video.currentTime = i * 100
      video.dispatchEvent(new Event("seeking"))
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6000)
    video.dispatchEvent(new Event("timeupdate"))
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6000)
    video.dispatchEvent(new Event("timeupdate"))
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(3)
  },
)

it("prefers a responsive Quality cache without any model request, even with provider admission disabled", async () => {
  const pending = deferred<SubtitleCandidateBundle[]>()
  const { publish, source } = setup(() => pending.promise, false)
  await vi.advanceTimersByTimeAsync(10)
  expect(mock.translate).not.toHaveBeenCalled()
  pending.resolve([
    {
      lane: "quality",
      cues: source.slice(0, 30).map((c) => ({ ...c, translation: "quality" })),
    } as SubtitleCandidateBundle,
  ])
  await vi.advanceTimersByTimeAsync(1)
  expect(publish).toHaveBeenCalledWith(expect.any(Array), "quality")
  expect(mock.translate).not.toHaveBeenCalled()
})

it("accepts late valid cache results, cancels redundant pending work, and does not start it again", async () => {
  const pending = deferred<SubtitleCandidateBundle[]>()
  mock.translate.mockImplementation(() => new Promise(() => {}))
  const { publish, source, engine } = setup(() => pending.promise)
  await vi.advanceTimersByTimeAsync(500)
  expect(mock.translate).toHaveBeenCalled()
  const starts = mock.translate.mock.calls.length
  const signals = mock.translate.mock.calls.map((c) => c[3].signal as AbortSignal)
  pending.resolve([
    {
      lane: "quality",
      cues: source.slice(0, 150).map((c) => ({ ...c, translation: "quality" })),
    } as SubtitleCandidateBundle,
  ])
  await vi.advanceTimersByTimeAsync(1)
  expect(publish).toHaveBeenCalledWith(expect.any(Array), "quality")
  expect(signals.every((s) => s.aborted)).toBe(true)
  for (let i = 0; i < 100; i++) engine.requestTick()
  await vi.advanceTimersByTimeAsync(10000)
  expect(mock.translate).toHaveBeenCalledTimes(starts)
})

it("aborts waiting on stop and rejects stale cache publication across restart", async () => {
  const pending = deferred<SubtitleCandidateBundle[]>()
  let signal: AbortSignal | undefined
  const { engine, publish, source } = setup(
    vi
      .fn((_start, _end, s) => {
        signal = s
        return pending.promise
      })
      .mockImplementationOnce((_start, _end, s) => {
        signal = s
        return pending.promise
      })
      .mockResolvedValue([]),
  )
  await vi.advanceTimersByTimeAsync(1)
  await engine.stop()
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  engine.start()
  pending.resolve([
    {
      lane: "quality",
      cues: [{ ...source[0]!, translation: "obsolete" }],
    } as SubtitleCandidateBundle,
  ])
  await vi.advanceTimersByTimeAsync(1)
  expect(
    publish.mock.calls.flatMap(([cues]) => cues).some((c) => c.translation === "obsolete"),
  ).toBe(false)
  expect(SUBTITLE_PERFORMANCE_DEFAULTS.cacheRestoreTimeoutMs).toBeLessThanOrEqual(500)
})
