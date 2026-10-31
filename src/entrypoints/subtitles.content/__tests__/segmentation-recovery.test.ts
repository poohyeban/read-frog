import { afterEach, describe, expect, it, vi } from "vitest"
import { sendMessage } from "@/utils/message"
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

afterEach(() => vi.clearAllMocks())

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
