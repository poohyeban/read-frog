import { createSubtitlesTranslationQueues } from "@/entrypoints/background/translation-queues"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { queueEvents } from "./queue-model"
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
;(window as any).runSubtitleBenchmark = async () => {
  const samples = []
  const config = (window as any).__config
  config.videoSubtitles.requestQueueConfig = { rate: 20, capacity: 1 }
  config.videoSubtitles.batchQueueConfig = { maxCharactersPerBatch: 6000, maxItemsPerBatch: 20 }
  for (let sample = 0; sample < 30; sample++) {
    for (const scenario of ["bounded-export-72", "current-after-auxiliary", "stop-inflight"]) {
      queueEvents.length = 0
      const factory = createSubtitlesTranslationQueues() as any
      const { requestQueue, batchQueue } = await (factory.queuesPromise ?? factory)
      const modern = !!factory.cancelledScopes
      const start = performance.now()
      const enqueue = (i: number) =>
        batchQueue.enqueue({
          text: `cue ${i}.`,
          hash: `${scenario}:${sample}:${i}`,
          scheduleAt: Date.now(),
          provider: { kind: "local", config: DEFAULT_PROVIDER_CONFIG.openai },
          langConfig: config.language,
          context: { webTitle: "fixture" },
          scope: "1:playback",
          priority: 0,
        })
      if (scenario === "bounded-export-72") {
        for (let i = 0; i < 72; i += 10)
          await Promise.all(Array.from({ length: Math.min(10, 72 - i) }, (_, j) => enqueue(i + j)))
      } else if (scenario === "current-after-auxiliary") {
        requestQueue.setQueueOptions({ rate: 5, capacity: 1 })
        const auxiliary = Array.from({ length: 4 }, (_, i) =>
          requestQueue.enqueue(
            async () => {
              queueEvents.push({
                at: performance.now(),
                phase: "auxiliary",
                items: 0,
                text: String(i),
              })
              await delay(20)
            },
            Date.now(),
            `aux${sample}:${i}`,
            ["1:export"],
            { priority: 3 },
          ),
        )
        await Promise.all(Array.from({ length: 5 }, (_, i) => enqueue(i)))
        await Promise.all(auxiliary)
      } else {
        const results = Promise.allSettled(Array.from({ length: 10 }, (_, i) => enqueue(i)))
        await delay(110)
        queueEvents.push({ at: performance.now(), phase: "stop", items: 0, text: "" })
        if (modern) {
          factory.cancelledScopes.markScope("1:playback")
          batchQueue.cancelByScope("1:playback")
          requestQueue.cancelByScope("1:playback")
        }
        await results
      }
      samples.push({
        sample,
        scenario,
        duration: performance.now() - start,
        events: queueEvents.map((event) => ({ ...event, at: event.at - start })),
      })
    }
  }
  return {
    samples,
    scales: [],
    note: "Actual production BatchQueue + RequestQueue factory in Chromium; only executeTranslate is a 20ms mock Provider. No real API calls or SW. Queue limits fixed identically in both versions.",
  }
}
