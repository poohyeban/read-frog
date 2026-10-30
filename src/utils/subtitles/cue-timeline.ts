import type { SubtitlesFragment } from "./types"

/** Timing alone is not unique: overlapping tracks can share a start timestamp. */
export function cueIdentity(
  cue: Pick<SubtitlesFragment, "id" | "start" | "end" | "text" | "sourceLanguage">,
): string {
  return JSON.stringify([cue.id ?? "", cue.start, cue.end, cue.text, cue.sourceLanguage ?? ""])
}
function lowerBound(values: readonly number[], target: number, strict = false) {
  let lo = 0,
    hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (strict ? values[mid]! <= target : values[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Sorted intervals + prefix maximum ends. No tree, stable first-cue overlap rule. */
export class CueTimeline<T extends SubtitlesFragment = SubtitlesFragment> {
  private items: readonly T[]
  get cues(): readonly T[] {
    return this.items
  }
  private starts: number[]
  private maxEnds: number[]
  private identities: Map<string, number>
  constructor(cues: readonly T[] = []) {
    this.items = cues
      .filter(
        (c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.end > 0,
      )
      .slice()
      .sort((a, b) => a.start - b.start)
    this.starts = this.cues.map((c) => c.start)
    let maxEnd = -Infinity
    this.maxEnds = this.cues.map((c) => (maxEnd = Math.max(maxEnd, c.end)))
    this.identities = new Map(this.cues.map((c, i) => [cueIdentity(c), i]))
  }
  /** O(log n), including arbitrarily long intervals and reverse seeks. */
  indexAt(timeMs: number): number {
    if (!Number.isFinite(timeMs)) return -1
    const index = lowerBound(this.maxEnds, timeMs, true)
    return index < this.cues.length && this.starts[index]! <= timeMs ? index : -1
  }
  at(timeMs: number): T | null {
    return this.cues[this.indexAt(timeMs)] ?? null
  }
  has(key: string) {
    return this.identities.has(key)
  }
  get(key: string): T | undefined {
    const index = this.identities.get(key)
    return index === undefined ? undefined : this.cues[index]
  }
  /** O(log n + examined overlaps); bounded result. Pathological overlaps can scan n. */
  window(start: number, end: number, limit = Infinity): T[] {
    const result: T[] = []
    if (end <= start || !Number.isFinite(start) || !Number.isFinite(end)) return result
    for (
      let i = lowerBound(this.maxEnds, start, true);
      i < this.cues.length && this.starts[i]! < end && result.length < limit;
      i++
    ) {
      if (this.cues[i]!.end > start) result.push(this.cues[i]!)
    }
    return result
  }
  /** One Map pass + one merge/sort, never a findIndex for each changed cue. */
  upsert(updates: readonly T[]): CueTimeline<T> {
    const items = [...this.items]
    let inserted = false
    for (const cue of updates) {
      const index = this.identities.get(cueIdentity(cue))
      if (index === undefined) {
        inserted = true
        items.push(cue)
      } else items[index] = cue
    }
    if (inserted) return new CueTimeline(items)
    const next = new CueTimeline<T>([])
    next.items = items
    next.starts = this.starts
    next.maxEnds = this.maxEnds
    next.identities = this.identities
    return next
  }
}
const indexes = new WeakMap<readonly SubtitlesFragment[], CueTimeline>()
/** Track arrays are immutable publications; old indexes are garbage collected with them. */
export function getCueTimeline<T extends SubtitlesFragment>(cues: readonly T[]): CueTimeline<T> {
  let timeline = indexes.get(cues)
  if (!timeline) {
    timeline = new CueTimeline(cues)
    indexes.set(cues, timeline)
  }
  return timeline as CueTimeline<T>
}
