import type { SubtitlesFragment } from "../types"
import { describe, expect, it } from "vitest"
import { CueTimeline, cueIdentity } from "../cue-timeline"
describe("CueTimeline", () => {
  it("matches linear first-active semantics for overlaps, equal starts, gaps and reverse seeks", () => {
    const cues = [
      { start: 0, end: 100000, text: "long" },
      { start: 1, end: 2, text: "short" },
      { start: 100000, end: 110000, text: "same A" },
      { start: 100000, end: 120000, text: "same B" },
    ]
    const index = new CueTimeline(cues)
    for (const time of [0, 1, 2, 1500, 99999, 100000, 110000, 119999, 120000, 10, -1])
      expect(index.at(time)).toBe(cues.find((c) => c.start <= time && c.end > time) ?? null)
    expect(index.window(100000, 120000)).toHaveLength(2)
    expect(cueIdentity(cues[2]!)).not.toBe(cueIdentity(cues[3]!))
  })
  it("keeps a 35:00–35:40 cue covering the 35:20 restored playhead", () => {
    const long = { start: 2100000, end: 2140000, text: "long" }
    const index = new CueTimeline([long, { start: 2140000, end: 2142000, text: "next" }])
    expect(index.at(2120000)).toBe(long)
    expect(index.window(2120000, 2150000)[0]).toBe(long)
  })
  it("rejects nonfinite and inverted timestamps and replaces only exact identities", () => {
    const a = { start: 0, end: 10, text: "A" },
      b = { start: 0, end: 10, text: "B" }
    const index = new CueTimeline<SubtitlesFragment>([
      a,
      b,
      { start: NaN, end: 20, text: "invalid" },
      { start: 30, end: 20, text: "reversed" },
    ])
    const next = index.upsert([{ ...a, translation: "译文" }])
    expect(next.cues).toHaveLength(2)
    expect(next.get(cueIdentity(a))?.translation).toBe("译文")
    expect(next.get(cueIdentity(b))?.translation).toBeUndefined()
  })
  it("agrees with a linear oracle on 50,000 cues and deterministic random positions", () => {
    const cues = Array.from({ length: 50000 }, (_, i) => ({
      start: i * 100,
      end: i * 100 + (i % 41 === 0 ? 5000 : 150),
      text: String(i),
    }))
    const index = new CueTimeline(cues)
    for (let i = 0; i < 1000; i++) {
      const time = (i * 7919) % 5000000
      expect(index.at(time)).toBe(cues.find((c) => c.start <= time && c.end > time) ?? null)
    }
  })
})
