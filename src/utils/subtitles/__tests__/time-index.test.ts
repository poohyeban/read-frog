import { describe, expect, it } from "vitest"
import { CueTimeIndex } from "../time-index"

describe("cue time index", () => {
  it("matches the original linear selection on seeded sorted and unsorted tracks", () => {
    let seed = 0x02518f2c
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let track = 0; track < 200; track++) {
      const cues = Array.from({ length: 200 }, () => {
        const start = Math.floor(random() * 5000)
        return { start, end: start + Math.floor(random() * 10000) - 100 }
      })
      if (track % 2 === 0) cues.sort((a, b) => a.start - b.start)
      const index = new CueTimeIndex(cues)
      const times = [
        -1,
        NaN,
        Infinity,
        -Infinity,
        ...cues.flatMap((cue) => [cue.start, cue.end, cue.end - 0.1]),
      ]
      for (const time of times) {
        expect(index.findActive(time)).toBe(
          cues.findIndex((cue) => cue.start <= time && cue.end > time),
        )
      }
    }
  })

  it("handles gaps, equal starts, long overlaps and empty tracks without clamping", () => {
    const cues = [
      { start: 100, end: 200 },
      { start: 100, end: 1000 },
      { start: 500, end: 600 },
      { start: 1500, end: 1600 },
    ]
    const index = new CueTimeIndex(cues)
    expect(
      [-1, 100, 200, 550, 1000, 1400, 1500, 1600].map((time) => index.findActive(time)),
    ).toEqual([-1, 0, 1, 1, -1, -1, 3, -1])
    expect(new CueTimeIndex([]).findActive(0)).toBe(-1)
  })

  it("requires an explicit new version after mutable track updates", () => {
    const cues = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]
    const before = new CueTimeIndex(cues)
    cues[0]!.end = 25
    cues.push({ start: 30, end: 40 })
    expect(before.findActive(21)).toBe(1)
    expect(new CueTimeIndex(cues).findActive(21)).toBe(0)
    expect(new CueTimeIndex(cues).findActive(35)).toBe(2)
  })

  it("falls back without rearranging invalid or unsorted timing data", () => {
    const cues = [
      { start: 5, end: NaN },
      { start: 10, end: 30 },
      { start: 0, end: 50 },
    ]
    expect(new CueTimeIndex(cues).findActive(12)).toBe(1)
    expect(cues[0]!.start).toBe(5)
  })
})
