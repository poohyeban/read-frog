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
  const trackKey = mode === "historical" ? current.getLegacyTrackKeys()[0]! : current.trackKey
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
      const exists =
        (await tracks.below(identity.trackKey).limit(1).count()) > 0 ||
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
    checks: { lazyCondition: legacyCalls === (mode === "current-only" ? 0 : 20) },
    note: "Actual production track identity and real IndexedDB bounded trackKey probe over 2,000 bundles. IPC excluded from this timing; current-only preserves one read IPC, first historical read adds one IPC. Eager executes the same three hashes as 4d65db03; historical timing includes deferred hashes, not just startup.",
  }
}
