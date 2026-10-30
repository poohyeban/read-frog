import { describe, expect, it } from "vitest"
import { buildSubtitlesSrtContent, formatSrtTimestamp } from "../srt"

describe("SRT output integrity", () => {
  it("sorts cues, preserves same-start different lines, normalizes negative/collapsed timing", () => {
    const srt = buildSubtitlesSrtContent([
      { text: "last", start: 2500, end: 3000 },
      { text: "first", start: -10, end: 0 },
      { text: "same start", start: 2500, end: 3500 },
    ])
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:00,001\nfirst\n\n2\n00:00:02,500 --> 00:00:03,000\nlast\n\n3\n00:00:02,500 --> 00:00:03,500\nsame start",
    )
  })
  it("rejects nonfinite timestamps instead of generating a malformed file", () => {
    expect(() => buildSubtitlesSrtContent([{ text: "bad", start: NaN, end: 1 }])).toThrow(
      "timestamp",
    )
    expect(() => formatSrtTimestamp(Infinity)).toThrow("timestamp")
  })
})
