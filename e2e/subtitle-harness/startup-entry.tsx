import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { Sha256Hex, Sha256Fields, safeLegacyFieldsHash } from "@/utils/hash"
import {
  subtitleCacheIdentity,
  legacySubtitleConfigIdentity,
} from "@/utils/subtitles/config-identity"

;(window as any).runSubtitleBenchmark = async () => {
  const source = Array.from({ length: 50000 }, (_, i) => ({
    start: i * 216,
    end: i * 216 + 200,
    text: `Sentence ${i} with enough words to represent a normal subtitle.`,
  }))
  const context = { videoTitle: "Three-hour video", subtitlesTextContent: "" }
  const mode = (window as any).__benchmarkMode
  const samples: number[] = [],
    heaps: number[] = []
  let keys: (string | undefined)[] = []
  for (let i = 0; i < 20; i++) {
    const stamp = performance.now()
    if (mode === "before") {
      keys = [
        Sha256Hex(
          "video",
          JSON.stringify(source),
          subtitleCacheIdentity(DEFAULT_CONFIG),
          JSON.stringify(context),
        ),
        Sha256Hex(
          "video",
          JSON.stringify(source),
          legacySubtitleConfigIdentity(DEFAULT_CONFIG),
          JSON.stringify(context),
        ),
      ]
    } else {
      const serializedTrack = JSON.stringify(source),
        serializedContext = JSON.stringify(context)
      const fields = [
        "video",
        serializedTrack,
        subtitleCacheIdentity(DEFAULT_CONFIG),
        serializedContext,
      ]
      keys = [
        Sha256Fields(...fields),
        safeLegacyFieldsHash(...fields),
        safeLegacyFieldsHash(
          "video",
          serializedTrack,
          legacySubtitleConfigIdentity(DEFAULT_CONFIG),
          serializedContext,
        ),
      ]
    }
    samples.push(performance.now() - stamp)
    heaps.push((performance as any).memory?.usedJSHeapSize)
  }
  return {
    size: source.length,
    mode,
    samples,
    heaps,
    keyCount: keys.length,
    providerStarts: 0,
    ipc: 0,
    reactCommits: 0,
    actualUsage: null,
    note: "Exact startup key formulas: baseline two historical hashes vs versioned identity plus both safe legacy lookups; 20 samples, 50,000 cues / three hours. Measures compatibility cost, not a claim of faster hashing.",
  }
}
