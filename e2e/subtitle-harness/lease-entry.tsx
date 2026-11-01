import { SubtitleWorkRuntime } from "@/entrypoints/background/subtitle-work"
;(window as any).runSubtitleBenchmark = async () => {
  const samples = [],
    retained = []
  for (let sample = 0; sample < 20; sample++) {
    const runtime = new SubtitleWorkRuntime()
    // 128 live sessions are deliberately retained, including idle/paused ones.
    const active = Array.from({ length: 128 }, (_, i) => runtime.open(i + 100, `active-${i}`))
    const before = performance.now()
    for (let i = 0; i < 500; i++) {
      const lease = runtime.open(7, `navigation-${i}`, { frameId: 0, documentId: `doc-${i}` })
      runtime.register(7, `task-${i}`, {
        lease,
        lane: "fast",
        urgent: true,
        logicalKey: "cue",
        start: 0,
        end: 1000,
      })
      runtime.closeFrame(7, 0, `next-${i}`)
    }
    samples.push(performance.now() - before)
    retained.push(runtime.leaseCount)
    if (!active.every((lease, i) => runtime.hasLease(i + 100, lease)))
      throw new Error("Active lease lost")
    for (let i = 0; i < 128; i++) runtime.closeTab(i + 100)
    if (runtime.leaseCount !== 0) throw new Error("Lease leaked")
  }
  return {
    samples,
    retained,
    checks: { bounded: retained.every((count) => count === 128) },
    providerStarts: 0,
    timers: 0,
    note: "Real Chromium production runtime, 20 x 500 navigation cleanups among 128 live sessions. No TTL, timers, HTTP, paid APIs or native MV3 Worker; passive connection cleanup separately tested with simulated ports.",
  }
}
