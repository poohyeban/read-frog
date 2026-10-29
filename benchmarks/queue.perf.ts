import { expect, it } from "vitest"
import { RequestQueue } from "@/utils/request/request-queue"
import { percentiles, report } from "./report"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const limits = [undefined, 2, 4, 8, 16, 32, 64] as const

type Sample = {
  elapsedMs: number
  firstCompletionMs: number
  peakAttempts: number
  completed: number
  failed: number
}

it("records queue load comparisons without a timing gate", async () => {
  const results: Record<string, Sample[]> = {}
  for (const scenario of ["fast", "slow", "burst", "sustained-429"]) {
    for (let round = -3; round < 30; round++) {
      // Rotate candidate order to distribute thermal/background drift.
      const order = [
        ...limits.slice((round + 3) % limits.length),
        ...limits.slice(0, (round + 3) % limits.length),
      ]
      for (const maxConcurrent of order) {
        const queue = new RequestQueue({
          rate: 10_000,
          capacity: 64,
          maxConcurrent,
          timeoutMs: 5000,
          maxRetries: 1,
          baseRetryDelayMs: 1,
          // Deliberately compressed cooldown for a scheduler simulation; this
          // is not a measurement of a remote provider's rate-limit behavior.
          retryPolicy:
            scenario === "sustained-429"
              ? {
                  decide: (_error, context) =>
                    context.rateLimitRetryCount < 1
                      ? { action: "pause-and-retry", pauseMs: 2 }
                      : { action: "fail" },
                }
              : undefined,
        })
        let active = 0
        let peak = 0
        let first = 0
        const start = performance.now()
        const scheduledAt = Date.now()
        const tasks = Array.from({ length: 64 }, (_, index) =>
          queue
            .enqueue(
              async () => {
                active++
                peak = Math.max(peak, active)
                await sleep(scenario === "slow" ? 10 : scenario === "burst" ? 4 : 1)
                active--
                if (scenario === "sustained-429") throw new Error("synthetic 429")
                return index
              },
              scheduledAt + (scenario === "burst" ? Math.floor(index / 8) * 4 : 0),
              String(index),
            )
            .then(
              (value) => {
                first ||= performance.now() - start
                return value
              },
              (error: unknown) => {
                first ||= performance.now() - start
                throw error
              },
            ),
        )
        const settled = await Promise.allSettled(tasks)
        expect(active).toBe(0)
        expect(peak).toBeLessThanOrEqual(maxConcurrent ?? 64)
        const sample = {
          elapsedMs: performance.now() - start,
          firstCompletionMs: first,
          peakAttempts: peak,
          completed: settled.filter((item) => item.status === "fulfilled").length,
          failed: settled.filter((item) => item.status === "rejected").length,
        }
        if (round >= 0) (results[`${scenario}/${maxConcurrent ?? "unbounded"}`] ??= []).push(sample)
      }
    }
  }
  await report("queue", {
    workload: "64 synthetic local attempts; 3 warmups then 30 rounds; no remote model calls",
    caveat:
      "Timer-based scheduler experiment, not browser latency or provider HTTP/inference timing. Persistent 429 uses a compressed 2ms synthetic cooldown.",
    default:
      "unbounded; real browser/provider evidence is required before enabling a finite production default",
    scenarios: Object.fromEntries(
      Object.entries(results).map(([name, samples]) => [
        name,
        {
          elapsedMs: percentiles(samples.map((sample) => sample.elapsedMs)),
          firstCompletionMs: percentiles(samples.map((sample) => sample.firstCompletionMs)),
          samples,
        },
      ]),
    ),
  })
})

const soakMs = Number(process.env.PERF_SOAK_MS ?? 0)
it.skipIf(soakMs <= 0)(
  "records post-GC queue resource trends separately from timing",
  async () => {
    if (!globalThis.gc) throw new Error("Run with the performance config's --expose-gc fork")
    const start = performance.now()
    let cycles = 0
    const samples: { elapsedMs: number; cycles: number; heapUsed: number; resources: string[] }[] =
      []
    let nextSample = 0
    while (performance.now() - start < soakMs) {
      const queue = new RequestQueue({
        rate: 1000,
        capacity: 32,
        maxConcurrent: 4,
        timeoutMs: 1000,
        maxRetries: 0,
        baseRetryDelayMs: 1,
      })
      await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          queue.enqueue(
            async () => {
              await sleep(1)
              return index
            },
            Date.now(),
            String(index),
          ),
        ),
      )
      cycles++
      if (performance.now() - start >= nextSample) {
        globalThis.gc()
        samples.push({
          elapsedMs: performance.now() - start,
          cycles,
          heapUsed: process.memoryUsage().heapUsed,
          resources: process.getActiveResourcesInfo().sort(),
        })
        await report("queue-soak", { requestedDurationMs: soakMs, complete: false, samples })
        nextSample += 30_000
      }
      await sleep(1000)
    }
    expect(cycles).toBeGreaterThan(0)
    globalThis.gc()
    samples.push({
      elapsedMs: performance.now() - start,
      cycles,
      heapUsed: process.memoryUsage().heapUsed,
      resources: process.getActiveResourcesInfo().sort(),
    })
    await report("queue-soak", {
      requestedDurationMs: soakMs,
      complete: true,
      caveat:
        "Node queue lifecycle only; does not establish browser DOM/listener or TTS/offscreen heap stability",
      samples,
    })
  },
  soakMs + 30_000,
)
