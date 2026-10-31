import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { aiSegmentBlock } from "@/utils/subtitles/processor/ai-segmentation"
import { SegmentationPipeline } from "../segmentation-pipeline"

vi.mock("@/utils/subtitles/processor/ai-segmentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/subtitles/processor/ai-segmentation")>()),
  aiSegmentBlock: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
}))
const source = [
  { text: "one", start: 0, end: 1000 },
  { text: "two", start: 1000, end: 2000 },
]
const ready = (cues: SubtitlesFragment[]) =>
  cues.map((cue) => ({
    ...cue,
    translation: `译:${cue.text}`,
    translationOutcome: { status: "success" as const },
  }))
function pipeline(raw = source) {
  return new SegmentationPipeline({
    rawFragments: raw,
    getVideoElement: () => ({ currentTime: 0, playbackRate: 1 }) as HTMLVideoElement,
    getSourceLanguage: () => "en",
    providerRef: { kind: "local", config: { id: "mock" } as never },
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(aiSegmentBlock).mockResolvedValue(source)
})

describe("Quality source block restoration", () => {
  it("proves complete legacy Quality without any segmentation cache or Provider call", async () => {
    const restored = pipeline()
    restored.restore(ready([{ text: "One, two!", start: 0, end: 2000 }]))
    expect(restored.hasUnprocessedChunks()).toBe(false)
    restored.start()
    await Promise.resolve()
    expect(aiSegmentBlock).not.toHaveBeenCalled()
    restored.stop()
  })
  it("only completes a manifest after all separately cached translation batches arrive", async () => {
    const original = pipeline()
    original.start()
    await vi.waitFor(() => expect(original.processedFragments).toHaveLength(2))
    original.stop()
    const cached = ready(original.processedFragments)
    const restored = pipeline()
    restored.restore([cached[0]!])
    expect(restored.hasUnprocessedChunks()).toBe(true)
    restored.restore([cached[1]!])
    expect(restored.hasUnprocessedChunks()).toBe(false)
    vi.mocked(aiSegmentBlock).mockClear()
    restored.start()
    await Promise.resolve()
    expect(aiSegmentBlock).not.toHaveBeenCalled()
    restored.stop()
  })
  it("partial, untranslated, invalid manifests and changed source never suppress necessary work", async () => {
    const original = pipeline()
    original.start()
    await vi.waitFor(() => expect(original.processedFragments).toHaveLength(2))
    original.stop()
    const cached = ready(original.processedFragments)
    for (const cues of [
      [cached[0]!],
      original.processedFragments,
      cached.map((c) => ({ ...c, segmentation: { ...c.segmentation!, count: 99 } })),
      cached.map((c) => ({ ...c, text: "different source" })),
    ]) {
      const restored = pipeline()
      restored.restore(cues)
      expect(restored.hasUnprocessedChunks()).toBe(true)
      const before = vi.mocked(aiSegmentBlock).mock.calls.length
      restored.start()
      await vi.waitFor(() => expect(aiSegmentBlock).toHaveBeenCalledTimes(before + 1))
      restored.stop()
    }
    const changed = pipeline([{ ...source[0]!, text: "new" }, source[1]!])
    changed.restore(cached)
    expect(changed.hasUnprocessedChunks()).toBe(true)
    changed.stop()
  })
})
