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
  it("falls back to source timing when a parseable AI response shifts the timeline", async () => {
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
    await vi.waitFor(() => expect(onChunkSegmented).toHaveBeenCalled())
    expect(pipeline.processedFragments[0]?.start).toBe(134200)
    expect(pipeline.processedFragments.at(-1)?.end).toBe(138160)
    expect(pipeline.processedFragments.map((cue) => cue.text).join(" ")).toBe(
      raw.map((cue) => cue.text).join(" "),
    )
    expect(pipeline.isRunning).toBe(false)
    pipeline.stop()
  })
})
