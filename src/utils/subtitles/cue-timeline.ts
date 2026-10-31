import type { SubtitlesFragment } from "./types"

type CueIdentityFields = Pick<SubtitlesFragment, "id" | "start" | "end" | "text" | "sourceLanguage">
const cueIdentities = new WeakMap<CueIdentityFields, CueIdentityFields & { key: string }>()
/** Stable snapshots avoid serialization; field checks also tolerate legacy mutable cues. */
export function cueIdentity(cue: CueIdentityFields): string {
  const cached = cueIdentities.get(cue)
  if (
    cached &&
    cached.id === cue.id &&
    cached.start === cue.start &&
    cached.end === cue.end &&
    cached.text === cue.text &&
    cached.sourceLanguage === cue.sourceLanguage
  )
    return cached.key
  const key = JSON.stringify([cue.id ?? "", cue.start, cue.end, cue.text, cue.sourceLanguage ?? ""])
  cueIdentities.set(cue, {
    id: cue.id,
    start: cue.start,
    end: cue.end,
    text: cue.text,
    sourceLanguage: cue.sourceLanguage,
    key,
  })
  return key
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

/** Sorted source order with a max-end interval index. No original cue is discarded. */
export class CueTimeline<T extends SubtitlesFragment = SubtitlesFragment> {
  private items: readonly T[]
  get cues(): readonly T[] {
    return this.items
  }
  private starts: number[]
  private maxEnds: number[]
  private overlapping = false
  private endTree?: number[]
  private equalStarts?: Map<number, number[]>
  private tree() {
    if (!this.endTree) {
      const tree = new Array<number>(Math.max(1, this.items.length * 4)).fill(-Infinity)
      const build = (node: number, lo: number, hi: number): number => {
        if (hi - lo === 1) return (tree[node] = this.items[lo]!.end)
        const mid = (lo + hi) >>> 1
        return (tree[node] = Math.max(build(node * 2, lo, mid), build(node * 2 + 1, mid, hi)))
      }
      if (this.items.length) build(1, 0, this.items.length)
      this.endTree = tree
    }
    return this.endTree
  }
  private tieGroups() {
    if (!this.equalStarts) {
      const groups = new Map<number, number[]>()
      for (let lo = 0; lo < this.items.length;) {
        let hi = lo + 1
        while (hi < this.items.length && this.starts[hi] === this.starts[lo]) hi++
        if (hi - lo > 1)
          groups.set(
            this.starts[lo]!,
            Array.from({ length: hi - lo }, (_, i) => lo + i).sort(
              (a, b) => this.items[a]!.end - this.items[b]!.end || a - b,
            ),
          )
        lo = hi
      }
      this.equalStarts = groups
    }
    return this.equalStarts
  }
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
    this.maxEnds = this.cues.map((c) => {
      if (c.start < maxEnd) this.overlapping = true
      return (maxEnd = Math.max(maxEnd, c.end))
    })
  }
  /** Latest start wins; equal starts prefer the shortest active cue, then source order. */
  indexAt(timeMs: number): number {
    if (!Number.isFinite(timeMs) || !this.items.length) return -1
    const upper = lowerBound(this.starts, timeMs, true)
    if (!this.overlapping) return upper > 0 && this.items[upper - 1]!.end > timeMs ? upper - 1 : -1
    const tree = this.tree()
    const find = (node: number, lo: number, hi: number): number => {
      if (lo >= upper || tree[node]! <= timeMs) return -1
      if (hi - lo === 1) return lo
      const mid = (lo + hi) >>> 1
      const right = find(node * 2 + 1, mid, hi)
      return right >= 0 ? right : find(node * 2, lo, mid)
    }
    const index = find(1, 0, this.items.length)
    if (index < 0) return -1
    if (
      this.starts[index - 1] !== this.starts[index] &&
      this.starts[index + 1] !== this.starts[index]
    )
      return index
    const group = this.tieGroups().get(this.starts[index]!)
    if (!group) return index
    let lo = 0,
      hi = group.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.items[group[mid]!]!.end <= timeMs) lo = mid + 1
      else hi = mid
    }
    return group[lo] ?? index
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
  /** Limit applies after eligibility. Expired subtrees are pruned even behind long cues. */
  window(
    start: number,
    end: number,
    limit = Infinity,
    eligible: (cue: T) => boolean = () => true,
  ): T[] {
    const result: T[] = []
    if (
      end <= start ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      limit <= 0 ||
      !this.items.length
    )
      return result
    const upper = lowerBound(this.starts, end)
    if (!this.overlapping) {
      for (let i = lowerBound(this.maxEnds, start, true); i < upper && result.length < limit; i++) {
        if (eligible(this.items[i]!)) result.push(this.items[i]!)
      }
      return result
    }
    const tree = this.tree()
    const visit = (node: number, lo: number, hi: number) => {
      if (lo >= upper || tree[node]! <= start || result.length >= limit) return
      if (hi - lo === 1) {
        const cue = this.items[lo]!
        if (eligible(cue)) result.push(cue)
        return
      }
      const mid = (lo + hi) >>> 1
      visit(node * 2, lo, mid)
      visit(node * 2 + 1, mid, hi)
    }
    visit(1, 0, this.items.length)
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
    next.overlapping = this.overlapping
    next.endTree = this.endTree
    next.equalStarts = this.equalStarts
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
