import { afterEach, describe, expect, it, vi } from "vitest"
import { sendMessage } from "@/utils/message"
import { SubtitleSession } from "@/utils/subtitles/session"
import { SegmentationPipeline } from "../segmentation-pipeline"

vi.mock("@/utils/message", () => ({ sendMessage: vi.fn<typeof sendMessage>() }))
const raw = [
  { text: "Moses had died.", start: 134200, end: 136160 },
  { text: "I thought the story was about him.", start: 136160, end: 138160 },
]
const providerRef = {
  kind: "local" as const,
  config: { id: "fixture", provider: "deepseek" } as never,
}

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe("segmentation response recovery", () => {
  it("rejects shifted AI timing and leaves the source unchanged", async () => {
    vi.mocked(sendMessage).mockResolvedValue(
      "WEBVTT\n\n0 --> 1960\nMoses had died.\n\n1960 --> 3960\nI thought the story was about him.",
    )
    const onChunkSegmented = vi.fn<() => void>()
    const pipeline = new SegmentationPipeline({
      baselineFragments: raw,
      rawFragments: raw,
      getVideoElement: () => ({ currentTime: 135 }) as HTMLVideoElement,
      getSourceLanguage: () => "en",
      providerRef,
      onChunkSegmented,
    })
    pipeline.start()
    await vi.waitFor(() => expect(pipeline.isRunning).toBe(false))
    expect(onChunkSegmented).not.toHaveBeenCalled()
    expect(pipeline.processedFragments).toEqual([])
    expect(raw[0]?.start).toBe(134200)
    expect(raw.at(-1)?.end).toBe(138160)
    pipeline.stop()
  })
})

it.each([false, true])(
  "recovers segmentation intake failures with a finite source budget (exhausted=%s)",
  async (exhausted) => {
    vi.useFakeTimers()
    let calls = 0
    vi.mocked(sendMessage).mockImplementation((async (type: string) => {
      if (type === "openSubtitleLease") return "boot:lease"
      if (type === "aiSegmentSubtitles") {
        calls++
        return {
          outcome: {
            status: "temporary",
            message: "intake busy",
            retryAfterMs: 2000,
            retryExhausted: exhausted,
          },
        }
      }
      return undefined
    }) as typeof sendMessage)
    const session = new SubtitleSession()
    const onChunkSegmented = vi.fn<() => void>()
    const pipeline = new SegmentationPipeline({
      session,
      rawFragments: raw,
      getVideoElement: () => ({ currentTime: 135 }) as HTMLVideoElement,
      getSourceLanguage: () => "en",
      providerRef,
      onChunkSegmented,
    })
    pipeline.start()
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(120001)
    expect(calls).toBe(exhausted ? 1 : 3)
    expect(onChunkSegmented).not.toHaveBeenCalled()
    expect(pipeline.hasUnprocessedChunks()).toBe(true)
    await session.stop()
    session.dispose()
    expect(vi.getTimerCount()).toBe(0)
  },
)

it("recovers the same segmentation chunk after a temporary rejection without replacing its source", async () => {
  vi.useFakeTimers()
  let calls = 0
  vi.mocked(sendMessage).mockImplementation((async (type: string) => {
    if (type === "openSubtitleLease") return "boot:lease"
    if (type === "aiSegmentSubtitles") {
      if (++calls === 1)
        return { outcome: { status: "temporary", message: "busy", retryAfterMs: 2000 } }
      return "WEBVTT\n\n134200 --> 136160\nMoses had died.\n\n136160 --> 138160\nI thought the story was about him."
    }
    return undefined
  }) as typeof sendMessage)
  const session = new SubtitleSession()
  const onChunkSegmented = vi.fn<() => void>()
  const pipeline = new SegmentationPipeline({
    session,
    rawFragments: raw,
    getVideoElement: () => ({ currentTime: 135 }) as HTMLVideoElement,
    getSourceLanguage: () => "en",
    providerRef,
    onChunkSegmented,
  })
  pipeline.start()
  await vi.advanceTimersByTimeAsync(2000)
  expect(calls).toBe(2)
  expect(onChunkSegmented).toHaveBeenCalledTimes(1)
  expect(pipeline.processedFragments.map(({ start, end, text }) => ({ start, end, text }))).toEqual(
    raw,
  )
  expect(pipeline.hasUnprocessedChunks()).toBe(false)
  await vi.advanceTimersByTimeAsync(120000)
  expect(calls).toBe(2)
  await session.stop()
  session.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
