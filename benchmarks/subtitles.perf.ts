import { expect, it } from "vitest"
import { CueTimeIndex } from "@/utils/subtitles/time-index"
import { percentiles, report } from "./report"

it("compares indexed selection with the baseline linear rule", async () => {
  const results = []
  for (const count of [100, 5000, 50000]) {
    for (const overlap of [false, true]) {
      const cues = Array.from({ length: count }, (_, index) => ({
        start: index * 1000,
        end: index * 1000 + (overlap ? 10_000 : 800),
      }))
      const times = Array.from(
        { length: 1000 },
        (_, index) => ((index * 7919) % count) * 1000 + (index % 2 === 0 ? 400 : 900),
      )
      const samples = []
      for (let round = -3; round < 30; round++) {
        const buildStarted = performance.now()
        const index = new CueTimeIndex(cues)
        const buildMs = performance.now() - buildStarted
        let baselineMs = 0
        let indexedMs = 0
        let baselineSum = 0
        let indexedSum = 0
        const linear = () => {
          const started = performance.now()
          for (const time of times)
            baselineSum += cues.findIndex((cue) => cue.start <= time && cue.end > time)
          baselineMs = performance.now() - started
        }
        const indexed = () => {
          const started = performance.now()
          for (const time of times) indexedSum += index.findActive(time)
          indexedMs = performance.now() - started
        }
        if (round % 2 === 0) {
          linear()
          indexed()
        } else {
          indexed()
          linear()
        }
        expect(indexedSum).toBe(baselineSum)
        if (round >= 0) samples.push({ baselineMs, indexedMs, buildMs })
      }
      results.push({
        count,
        overlap,
        queriesPerSample: times.length,
        auxiliaryBytes: count * 16,
        baselineMs: percentiles(samples.map((sample) => sample.baselineMs)),
        indexedMs: percentiles(samples.map((sample) => sample.indexedMs)),
        buildMs: percentiles(samples.map((sample) => sample.buildMs)),
        samples,
      })
    }
  }
  await report("subtitle-index", {
    warmups: 3,
    measuredRounds: 30,
    caveat:
      "Local algorithm timing; construction recorded separately; no browser rendering included",
    results,
  })
})
