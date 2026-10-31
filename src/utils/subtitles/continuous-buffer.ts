import type { SubtitlesFragment } from "./types"
import { getCueTimeline } from "./cue-timeline"

/** First untranslated speech, not a sum of disjoint completed intervals. Silence costs no work. */
export function continuousReadyMs(
  source: readonly SubtitlesFragment[],
  ready: readonly SubtitlesFragment[],
  time: number,
  horizon: number,
): number {
  const end = time + horizon
  const candidates = getCueTimeline(ready)
    .window(time, end)
    .filter(
      (c) =>
        c.translation?.trim() &&
        (!c.translationOutcome || c.translationOutcome.status === "success"),
    )
  let index = 0
  for (const cue of getCueTimeline(source).window(time, end)) {
    let cursor = Math.max(time, cue.start)
    const requiredEnd = Math.min(end, cue.end)
    while (cursor < requiredEnd) {
      while (index < candidates.length && candidates[index]!.end <= cursor) index++
      if (!candidates[index] || candidates[index]!.start > cursor) return Math.max(0, cursor - time)
      cursor = Math.max(cursor, candidates[index]!.end)
    }
  }
  return horizon
}

export class SubtitleBufferController {
  private latencies: number[] = []
  private qualityLatencies: number[] = []
  fastSpeculation = true
  observe(ms: number, quality = false) {
    const values = quality ? this.qualityLatencies : this.latencies
    values.push(ms)
    if (values.length > 32) values.shift()
  }
  private p95(values: number[], fallback: number) {
    return values.length
      ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!
      : fallback
  }
  get lowMs() {
    return Math.min(30_000, Math.max(8000, this.p95(this.latencies, 1000) * 2 + 2000))
  }
  get highMs() {
    return Math.min(60_000, Math.max(20_000, this.lowMs + 12_000))
  }
  get qualityEstimateMs() {
    return this.p95(this.qualityLatencies, 15_000)
  }
  update(qualityMs: number, rate = 1) {
    const coverage = qualityMs / Math.max(0.25, rate)
    if (this.fastSpeculation && coverage >= this.highMs) this.fastSpeculation = false
    else if (!this.fastSpeculation && coverage <= this.lowMs) this.fastSpeculation = true
    return this.fastSpeculation
  }
}
