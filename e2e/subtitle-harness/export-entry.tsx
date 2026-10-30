import { TranslatedSubtitlesDownloader } from "@/entrypoints/subtitles.content/translated-subtitles-downloader"
import { exports } from "./export-fixture"
import { model } from "./model"
;(window as any).runSubtitleBenchmark = async () => {
  const config = (window as any).__config
  config.language.targetCode = "cmn"
  config.videoSubtitles.aiSegmentation = false
  model.delay = -1
  const scales = []
  for (const size of [100, 1000, 10000, 50000]) {
    const samples = []
    for (let sample = 0; sample < 3; sample++) {
      model.reset()
      exports.length = 0
      const source = Array.from({ length: size }, (_, i) => ({
        start: i * 2000,
        end: i * 2000 + 1800,
        text: `Sentence ${i}.`,
      }))
      const fetcher = {
        fetch: async () => source,
        cleanup: () => {},
        getSourceLanguage: () => "en",
        shouldUseSameTrack: async () => true,
        hasAvailableSubtitles: async () => true,
        isPreSegmented: () => true,
      }
      const downloader = new TranslatedSubtitlesDownloader(() => fetcher, {
        platform: "youtube",
        selectors: {},
        events: {},
        getVideoId: () => "export-fixture",
      } as any)
      const start = performance.now()
      await downloader.download()
      samples.push({
        duration: performance.now() - start,
        result: exports[0] ?? null,
        translationCalls: model.events.filter((e) => e.type === "translate:enqueue").length,
        heap: (performance as any).memory.usedJSHeapSize,
      })
      downloader.dispose()
    }
    scales.push({ size, samples })
  }
  return {
    scales,
    note: "Actual downloader + SRT builder; presegmented source, three full exports per size; zero-latency mock translator, no Provider billing and no disk download. These calls are content batches, not HTTP requests.",
  }
}
