export interface CueInterval {
  start: number
  end: number
}

/**
 * Immutable index of one track version. Callers rebuild on replacement, recut
 * or incremental timing updates, never on playback ticks. For sorted starts,
 * the first prefix maximum above t identifies the FIRST cue whose end > t;
 * if its start is after t, all later starts are too. This preserves long and
 * overlapping cues instead of choosing the most recently started cue.
 */
export class CueTimeIndex {
  private starts: Float64Array
  private ends: Float64Array
  readonly sorted: boolean

  constructor(cues: readonly CueInterval[]) {
    this.starts = new Float64Array(cues.length)
    this.ends = new Float64Array(cues.length)
    let sorted = true
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index]!
      this.starts[index] = cue.start
      this.ends[index] = cue.end
      if (
        Number.isNaN(cue.start) ||
        Number.isNaN(cue.end) ||
        (index > 0 && cue.start < this.starts[index - 1]!)
      )
        sorted = false
    }
    this.sorted = sorted
    if (sorted) {
      for (let index = 1; index < cues.length; index++) {
        this.ends[index] = Math.max(this.ends[index]!, this.ends[index - 1]!)
      }
    }
  }

  /** Earliest possible overlap; unsorted tracks must scan in original order. */
  firstEndingAfter(timeMs: number): number {
    if (!this.sorted) return 0
    let low = 0
    let high = this.ends.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (this.ends[middle]! <= timeMs) low = middle + 1
      else high = middle
    }
    return low
  }

  findActive(timeMs: number): number {
    if (Number.isNaN(timeMs)) return -1
    if (!this.sorted) {
      for (let index = 0; index < this.starts.length; index++) {
        if (this.starts[index]! <= timeMs && this.ends[index]! > timeMs) return index
      }
      return -1
    }
    const index = this.firstEndingAfter(timeMs)
    return index < this.starts.length && this.starts[index]! <= timeMs ? index : -1
  }
}
