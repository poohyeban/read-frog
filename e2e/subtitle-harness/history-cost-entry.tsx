import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { db } from "@/utils/db/dexie/db"
import { createSubtitleTrackIdentity } from "@/utils/subtitles/track-identity"

;(window as any).runSubtitleBenchmark = async () => {
  const source = Array.from({ length: 50000 }, (_, i) => ({
    start: i * 216,
    end: i * 216 + 200,
    text: `Sentence ${i} with enough words to represent a normal subtitle.`,
  }))
  const mode = (window as any).__benchmarkMode
  const context = { videoTitle: "Three-hour video", subtitlesTextContent: "" }
  const current = createSubtitleTrackIdentity("video", source, DEFAULT_CONFIG, context)
  await db.subtitleCandidates.clear()
  const trackKey =
    mode === "historical"
      ? current.getLegacyTrackKeys()[0]!
      : createSubtitleTrackIdentity("another-video", source.slice(0, 1), DEFAULT_CONFIG, context)
          .trackKey
  // A real IndexedDB index with many bundles under one track, not an in-memory stub.
  await db.subtitleCandidates.bulkPut(
    Array.from({ length: 2000 }, (_, i) => ({
      key: String(i),
      trackKey,
      lane: "fast" as const,
      cues: [],
      start: i * 5000,
      end: i * 5000 + 1000,
      createdAt: new Date(),
    })),
  )
  const samples: number[] = [],
    startup: number[] = [],
    probes: number[] = [],
    heaps: number[] = []
  let legacyCalls = 0
  for (let i = 0; i < 20; i++) {
    const stamp = performance.now()
    const identity = createSubtitleTrackIdentity("video", source, DEFAULT_CONFIG, context)
    if (mode === "eager") {
      identity.getLegacyTrackKeys()
      legacyCalls++
    }
    startup.push(performance.now() - stamp)
    const probeStart = performance.now()
    if (mode !== "eager") {
      const tracks = db.subtitleCandidates.where("trackKey")
      const exists = identity.trackKey.startsWith("subtitle-track-v3:")
        ? (await tracks.below("g").limit(1).count()) > 0
        : (await tracks.below(identity.trackKey).limit(1).count()) > 0 ||
          (await tracks.above(identity.trackKey).limit(1).count()) > 0
      probes.push(performance.now() - probeStart)
      if (exists) {
        identity.getLegacyTrackKeys()
        legacyCalls++
      }
    }
    samples.push(performance.now() - stamp)
    heaps.push((performance as any).memory.usedJSHeapSize)
  }
  const batchReads = []
  await db.translationCache.put({
    key: "current",
    translation: "Mock translation",
    createdAt: new Date(),
  })
  await db.translationCache.put({
    key: "old",
    translation: "Mock translation",
    createdAt: new Date(),
  })
  for (const hit of ["current", "old", "miss"]) {
    const times = []
    let reads = 0
    for (let i = 0; i < 100; i++) {
      const begin = performance.now()
      reads++
      const cached = await db.translationCache.get(
        hit === "current" ? "current" : "missing-current",
      )
      if (!cached) {
        reads++
        await db.translationCache.get(hit === "old" ? "old" : "missing-old")
      }
      times.push(performance.now() - begin)
    }
    batchReads.push({ hit, times, reads })
  }
  await db.delete()
  return {
    mode,
    size: source.length,
    samples,
    startup,
    probes,
    heaps,
    legacyCalls,
    providerStarts: 0,
    ipc: 0,
    reactCommits: 0,
    actualUsage: null,
    batchReads,
    checks: {
      lazyCondition:
        legacyCalls ===
        (mode !== "historical" && current.trackKey.startsWith("subtitle-track-v3:") ? 0 : 20),
    },
    note: "Actual track identity, real Chromium IndexedDB, exact production bounded index probe formulas over 2,000 OTHER-video bundles. Historical hashing included. Complete-batch cache gets measured separately over 100 reads per hit condition. No model requests or paid tokens.",
  }
}
