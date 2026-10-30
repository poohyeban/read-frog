import { describe, expect, it, vi } from "vitest"
import { optimizeSubtitles } from "@/utils/subtitles/processor/optimizer"
import { SubtitleSession } from "@/utils/subtitles/session"
import { SegmentationPipeline } from "../segmentation-pipeline"

describe("windowed rule fallback against the full-track quality baseline", () => {
  it.each([
    ["en", "A complete sentence"],
    ["zh", "这是一句完整的字幕"],
    ["ja", "これは完全な字幕です"],
    ["ar", "هذه جملة كاملة"],
  ])(
    "preserves every source marker and valid timing in %s after restored-position recutting",
    async (language, text) => {
      const raw = Array.from({ length: 1800 }, (_, i) => ({
        text: `${text} ${i}.`,
        start: i * 2000,
        end: i * 2000 + 1800,
      }))
      const baseline = optimizeSubtitles(raw, language)
      const windows: number[] = []
      const session = new SubtitleSession()
      const pipeline = new SegmentationPipeline({
        session,
        rawFragments: raw,
        baselineFragments: baseline,
        getVideoElement: () => ({ currentTime: 2120, playbackRate: 1 }) as HTMLVideoElement,
        getSourceLanguage: () => language,
        providerRef: null,
        onChunkSegmented: (chunk) => windows.push(chunk[0]!.start),
      })
      pipeline.start()
      await vi.waitFor(() => expect(pipeline.isRunning).toBe(false))
      const markers = (cues: typeof raw) =>
        cues
          .map((cue) => cue.text)
          .join(" ")
          .match(/\d+/g)
      expect(markers(pipeline.processedFragments)).toEqual(markers(baseline))
      expect(markers(pipeline.processedFragments)).toHaveLength(1800)
      expect(windows[0]).toBeGreaterThan(0)
      expect(
        pipeline.processedFragments.every(
          (cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start,
        ),
      ).toBe(true)
      expect(pipeline.processedFragments[0]?.start).toBe(baseline[0]?.start)
      expect(pipeline.processedFragments.at(-1)?.end).toBe(baseline.at(-1)?.end)
      session.dispose()
    },
  )
})
