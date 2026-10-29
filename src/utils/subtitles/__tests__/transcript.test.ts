import type { SubtitlesFragment } from "../types"
import { describe, expect, it } from "vitest"
import { buildTranscript, findActiveLine, formatTimestamp } from "../transcript"

function cue(text: string, start: number, end: number, translation?: string): SubtitlesFragment {
  return { text, start, end, ...(translation && { translation }) }
}

const SOURCE = [cue("one", 0, 1000), cue("two", 2000, 3000), cue("three", 4000, 5000)]

describe("buildTranscript", () => {
  it("pairs translations onto the source line with the same start", () => {
    const lines = buildTranscript(SOURCE, [cue("two", 2000, 3000, "二")])

    expect(lines.map((l) => l.translation)).toEqual([undefined, "二", undefined])
  })

  it("preserves unchanged row identity without retaining a stale translation", () => {
    const first = buildTranscript(SOURCE, [])
    const next = buildTranscript(SOURCE, [cue("two", 2000, 3000, "二")], first)
    expect(next[0]).toBe(first[0])
    expect(next[2]).toBe(first[2])
    expect(next[1]).not.toBe(first[1])
    expect(next[1]?.translation).toBe("二")
    expect(buildTranscript([...SOURCE], [cue("two", 2000, 3000, "二")], next)).toBe(next)
    const removed = buildTranscript(SOURCE, [], next)
    expect(removed[1]?.translation).toBeUndefined()
    expect(removed[0]).toBe(next[0])
  })

  it("keeps every source line when nothing is translated yet", () => {
    const lines = buildTranscript(SOURCE, [])

    expect(lines.map((l) => l.text)).toEqual(["one", "two", "three"])
    expect(lines.every((l) => l.translation === undefined)).toBe(true)
  })

  it("does not attach a translation whose start matches no source line", () => {
    const lines = buildTranscript(SOURCE, [cue("stale", 9999, 10_000, "旧")])

    expect(lines.every((l) => l.translation === undefined)).toBe(true)
  })

  it("ignores translated cues that carry no translation", () => {
    const lines = buildTranscript(SOURCE, [cue("two", 2000, 3000)])

    expect(lines[1]!.translation).toBeUndefined()
  })

  it("drops a translation that repeats its source line", () => {
    const lines = buildTranscript(SOURCE, [cue("two", 2000, 3000, "two")])

    expect(lines[1]!.translation).toBeUndefined()
  })
})

describe("findActiveLine", () => {
  const lines = buildTranscript(SOURCE, [])

  it("chooses the first array entry across overlaps, including a long earlier cue", () => {
    const overlaps = [cue("long", 100, 10000), cue("short", 500, 600), cue("middle", 900, 1500)]
    expect(findActiveLine(overlaps, 550)).toBe(0)
    expect(findActiveLine(overlaps, 1100)).toBe(0)
    expect(findActiveLine(overlaps, 10000)).toBe(-1)
  })

  it("preserves equal-start order and never silently sorts unsorted input", () => {
    const overlaps = [cue("first", 500, 700), cue("earlier", 0, 1000), cue("same", 500, 2000)]
    expect(findActiveLine(overlaps, 550)).toBe(0)
    expect(findActiveLine(overlaps, 700)).toBe(1)
    expect(findActiveLine(overlaps, 1000)).toBe(2)
    expect(findActiveLine(overlaps, -1)).toBe(-1)
    expect(findActiveLine(overlaps, NaN)).toBe(-1)
  })

  it("finds the line covering the playhead", () => {
    expect(findActiveLine(lines, 2500)).toBe(1)
  })

  it("treats start as inside and end as outside", () => {
    expect(findActiveLine(lines, 2000)).toBe(1)
    expect(findActiveLine(lines, 3000)).toBe(-1)
  })

  it("reports nothing in the gap between cues", () => {
    expect(findActiveLine(lines, 1500)).toBe(-1)
  })

  it("reports nothing before the first cue or after the last", () => {
    expect(findActiveLine(lines, 0)).toBe(0)
    expect(findActiveLine(lines, 9999)).toBe(-1)
  })
})

describe("formatTimestamp", () => {
  it("pads the seconds but not the leading minutes", () => {
    expect(formatTimestamp(9_000)).toBe("0:09")
    expect(formatTimestamp(75_000)).toBe("1:15")
  })

  it("widens to hours only once the video reaches one", () => {
    expect(formatTimestamp(3_599_000)).toBe("59:59")
    expect(formatTimestamp(3_671_000)).toBe("1:01:11")
  })
})
