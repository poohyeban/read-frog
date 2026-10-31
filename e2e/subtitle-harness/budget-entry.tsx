import { SubtitleWorkRuntime } from "@/entrypoints/background/subtitle-work"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { db } from "@/utils/db/dexie/db"
import { chunkSubtitleWork, assertSubtitleWindow } from "@/utils/subtitles/work-policy"

// Real Chromium IndexedDB transactions; the provider is a deterministic local counter.
;(window as any).runSubtitleBenchmark = async () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.videoSubtitles.workBudget = {
    requests: 10,
    estimatedTokens: 100000,
    emergencyPercent: 20,
    maxInFlight: 1,
    diagnostics: true,
  }
  ;(window as any).__config = config
  await db.subtitleBudget.clear()
  await db.subtitleAttempt.clear()
  const runtimes: SubtitleWorkRuntime[] = []
  let starts = 0
  function task(id: number, urgent: boolean) {
    const runtime = new SubtitleWorkRuntime()
    runtimes.push(runtime)
    const lease = runtime.open(id)
    runtime.register(id, String(id), {
      lease,
      lane: urgent ? "fast" : "quality",
      urgent,
      logicalKey: String(id),
      start: 0,
      end: 2000,
    })
    const guard = runtime.guard(() => [String(id)], [String(id)])
    return {
      runtime,
      lease,
      call: async () => {
        await guard.beforeCall("bounded fixture", 128)
        guard.onDispatch?.()
        starts++
        await guard.usage({ inputTokens: 8, outputTokens: 12 })
      },
    }
  }
  for (let i = 0; i < 8; i++) await task(i, false).call()
  const soft = await Promise.allSettled([task(8, false).call()])
  if (soft[0]?.status !== "rejected") throw new Error("soft reserve leaked")
  await task(9, true).call()
  // Two independent runtime instances race the final durable credit in IndexedDB.
  const race = await Promise.allSettled([task(10, true).call(), task(11, true).call()])
  if (race.filter((r) => r.status === "fulfilled").length !== 1)
    throw new Error("non-atomic final credit")
  for (let i = 12; i < 112; i++)
    await task(i, true)
      .call()
      .catch(() => {})
  const stopped = task(112, true)
  stopped.runtime.revoke(112, stopped.lease)
  const startsBeforeStopProbe = starts
  await stopped.call().catch(() => {})
  const postStopStarts = starts - startsBeforeStopProbe
  // Re-open the actual IndexedDB connection, as on worker restart.
  db.close()
  await db.open()
  const ledger = await db.subtitleBudget.get("playback")
  if (starts !== 10 || ledger?.requests !== 10) throw new Error("cumulative budget reset")
  const track = Array.from({ length: 5400 }, (_, i) => ({
    start: i * 2000,
    end: i * 2000 + 1800,
    text: `Cue ${i}.`,
  }))
  const chunks = chunkSubtitleWork(track)
  chunks.forEach(assertSubtitleWindow)
  const counters: Record<string, number> = {}
  for (const runtime of runtimes)
    for (const [key, value] of Object.entries(runtime.snapshot().counters))
      counters[key] = (counters[key] ?? 0) + value
  return {
    model: "Mock Provider, no paid tokens",
    actualProviderStarts: starts,
    ledger,
    counters,
    exportThreeHours: {
      sourceCues: track.length,
      chunks: chunks.length,
      maximumCues: Math.max(...chunks.map((c) => c.length)),
      maximumSpanMs: Math.max(...chunks.map((c) => c.at(-1)!.end - c[0]!.start)),
    },
    postStopStarts,
    retries: counters.retry ?? 0,
    cacheHits: counters["cache-hit"] ?? 0,
    realProviderUsage: null,
    note: "ledger usage is synthetic Mock Provider usage; it is not real paid API usage",
  }
}
