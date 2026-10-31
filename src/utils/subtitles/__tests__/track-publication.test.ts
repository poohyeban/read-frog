import type { SubtitlesFragment } from "../types"
import { describe, expect, it } from "vitest"
import { cueIdentity } from "../cue-timeline"
import { recordTrackPublication } from "../track-publication"
import { buildTranscript } from "../transcript"

describe("incremental immutable subtitle publications", () => {
  it("reuses unchanged rows, preserves previous snapshots and falls back for Quality merges", () => {
    const source = [0, 1000, 2000].map((start) => ({
      start,
      end: start + 1000,
      text: String(start),
    }))
    const initial: SubtitlesFragment[] = source.map((cue) => ({
      ...cue,
      translation: `T:${cue.text}`,
    }))
    const before = buildTranscript(source, initial)
    const update = { ...initial[1]!, translation: "changed" }
    const next = [initial[0]!, update, initial[2]!]
    recordTrackPublication(next, initial, [update])
    const after = buildTranscript(source, next)
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]?.translation).toBe("changed")
    expect(before[1]?.translation).toBe("T:1000")
    const quality: SubtitlesFragment = {
      start: 0,
      end: 2000,
      text: "0 1000",
      translation: "merged",
      lane: "quality",
    }
    const merged = buildTranscript(source, [quality, ...next])
    expect(merged.map((c) => c.translation)).toEqual(["merged", "T:2000"])
    expect(buildTranscript(source, []).every((c) => !c.translation)).toBe(true)
  })
  it("invalidates memoized identities when legacy mutable cue fields change", () => {
    const cue: SubtitlesFragment = { start: 0, end: 10, text: "first" }
    const first = cueIdentity(cue)
    expect(cueIdentity(cue)).toBe(first)
    cue.text = "second"
    expect(cueIdentity(cue)).not.toBe(first)
    expect(cueIdentity(cue)).toBe(cueIdentity({ ...cue }))
  })
})
