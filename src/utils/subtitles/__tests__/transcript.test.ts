import type { SubtitlesFragment } from "../types"
import { describe, expect, it } from "vitest"
import { buildTranscript, findActiveLine, formatTimestamp } from "../transcript"

function cue(text: string, start: number, end: number, translation?: string): SubtitlesFragment {
  return { text, start, end, ...(translation && { translation }) }
}

const SOURCE = [cue("one", 0, 1000), cue("two", 2000, 3000), cue("three", 4000, 5000)]

describe("buildTranscript", () => {
  it("pairs translations onto the source line with the same identity", () => {
    const lines = buildTranscript(SOURCE, [cue("two", 2000, 3000, "二")])

    expect(lines.map((l) => l.translation)).toEqual([undefined, "二", undefined])
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
  it("reuses unchanged row references and rejects same-start stale translations", () => {
    const first = buildTranscript(SOURCE, [])
    const next = buildTranscript(SOURCE, [cue("two", 2000, 3000, "二")])
    expect(next[0]).toBe(first[0])
    expect(next[1]).not.toBe(first[1])
    expect(next[2]).toBe(first[2])
    const recut = buildTranscript([cue("new words", 2000, 4000)], [cue("two", 2000, 3000, "旧")])
    expect(recut[0]?.translation).toBeUndefined()
  })
})

describe("findActiveLine", () => {
  const lines = buildTranscript(SOURCE, [])

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

describe("Quality merged transcript rows", () => {
  const raw = [
    cue("one", 0, 1000),
    cue("two", 1000, 2000),
    cue("three", 2000, 3000),
    cue("four", 3000, 4000),
  ]
  it("uses complete Quality original/translation pairs over Fast with different boundaries", () => {
    const baseline = [cue("one two three", 0, 3000), raw[3]!]
    const fast = { ...baseline[0]!, translation: "Fast 一二三", lane: "fast" as const }
    const quality = { ...cue("One, two!", 0, 2000, "Quality 一二"), lane: "quality" as const }
    const before = buildTranscript(baseline, [fast], raw)
    const next = buildTranscript(baseline, [fast, quality], raw)
    expect(next.map((l) => [l.text, l.translation])).toEqual([
      ["One, two!", "Quality 一二"],
      ["three", undefined],
      ["four", undefined],
    ])
    expect(next[0]!.anchorKey).toBe(before[0]!.anchorKey)
    expect(next[2]).toBe(before[1])
    expect(findActiveLine(next, 1500)).toBe(0)
    expect(findActiveLine(next, 2500)).toBe(1)
  })
  it("keeps Fast until Quality is complete and ignores failed or changed-source candidates", () => {
    const fast = { ...raw[0]!, translation: "Fast", lane: "fast" as const }
    for (const quality of [
      { ...raw[0]!, lane: "quality" as const },
      {
        ...raw[0]!,
        lane: "quality" as const,
        translation: "bad",
        translationOutcome: { status: "temporary" as const, message: "failed" },
      },
      { ...raw[0]!, lane: "quality" as const, text: "unrelated", translation: "wrong source" },
    ]) {
      expect(buildTranscript(raw, [fast, quality])[0]!.translation).toBe("Fast")
    }
  })
  it("does not let a later Fast result overwrite identical Quality boundaries", () => {
    const quality = { ...raw[0]!, translation: "Quality", lane: "quality" as const }
    const fast = { ...raw[0]!, translation: "Fast", lane: "fast" as const }
    expect(buildTranscript(raw, [quality, fast])[0]!.translation).toBe("Quality")
  })
})
