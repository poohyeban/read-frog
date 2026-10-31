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
  private identities?: Map<string, number>
  private identityIndex() {
    return (this.identities ??= new Map(this.cues.map((cue, index) => [cueIdentity(cue), index])))
  }
  constructor(cues: readonly T[] = [], alreadySorted = false) {
    const valid = cues.filter(
      (c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.end > 0,
    )
    this.items = alreadySorted ? valid : valid.sort((a, b) => a.start - b.start)
    this.starts = this.cues.map((c) => c.start)
    let maxEnd = -Infinity
    this.maxEnds = this.cues.map((c) => (maxEnd = Math.max(maxEnd, c.end)))
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
    return this.identityIndex().has(key)
  }
  get(key: string): T | undefined {
    const index = this.identityIndex().get(key)
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
  /** O(n + m log m) for insertions, O(n + m) for value-only updates. */
  upsert(updates: readonly T[]): CueTimeline<T> {
    const items = [...this.items]
    const additions = new Map<string, T>()
    for (const cue of updates) {
      const key = cueIdentity(cue)
      const index = this.identityIndex().get(key)
      if (index === undefined) {
        additions.set(key, cue)
      } else items[index] = cue
    }
    if (additions.size) {
      const incoming = [...additions.values()].sort((a, b) => a.start - b.start)
      const merged: T[] = []
      let left = 0,
        right = 0
      while (left < items.length && right < incoming.length) {
        if (items[left]!.start <= incoming[right]!.start) merged.push(items[left++]!)
        else merged.push(incoming[right++]!)
      }
      while (left < items.length) merged.push(items[left++]!)
      while (right < incoming.length) merged.push(incoming[right++]!)
      const next = new CueTimeline(merged, true)
      // Mutation timelines will be updated again. Pay their identity-index cost with
      // the insertion, while read-only source timelines keep lazy lookup indexes.
      next.identityIndex()
      return next
    }
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
