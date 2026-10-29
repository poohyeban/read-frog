import { describe, expect, it } from "vitest"
import { isSegmentationAligned } from "../ai-segmentation"

const source = [
  { start: 134200, end: 134760, text: "Moses" },
  { start: 134760, end: 135160, text: "had" },
  { start: 135160, end: 136160, text: "died" },
  { start: 136160, end: 136720, text: "I thought" },
  { start: 136720, end: 138160, text: "the story was about him" },
]
const aligned = [
  { start: 134200, end: 136160, text: "Moses had died." },
  { start: 136160, end: 138160, text: "I thought the story was about him." },
]

describe("AI subtitle timeline validation", () => {
  it("accepts grouping and punctuation with the source word boundaries", () => {
    expect(isSegmentationAligned(source, aligned)).toBe(true)
  })

  it.each([
    [
      "relative timestamps",
      aligned.map((cue) => ({ ...cue, start: cue.start - 134200, end: cue.end - 134200 })),
    ],
    [
      "seconds instead of milliseconds",
      aligned.map((cue) => ({ ...cue, start: cue.start / 1000, end: cue.end / 1000 })),
    ],
    ["wrong sentence boundary", [{ ...aligned[0]!, end: 138160 }, aligned[1]!]],
    [
      "text assigned to the wrong interval",
      [
        { ...aligned[0]!, text: aligned[1]!.text },
        { ...aligned[1]!, text: aligned[0]!.text },
      ],
    ],
    ["omitted trailing text", aligned.slice(0, 1)],
    ["duplicate cue", [aligned[0]!, ...aligned]],
    [
      "invented inner timestamp",
      [
        { start: 134200, end: 134500, text: "Mo" },
        { start: 134500, end: 136160, text: "ses had died." },
        aligned[1]!,
      ],
    ],
    ["reversed interval", [{ ...aligned[0]!, end: 134000 }, aligned[1]!]],
    ["empty result", []],
  ])("rejects %s", (_name, result) => {
    expect(isSegmentationAligned(source, result)).toBe(false)
  })

  it("accepts CJK punctuation without assuming space-separated words", () => {
    expect(
      isSegmentationAligned(
        [
          { start: 10, end: 20, text: "你好" },
          { start: 20, end: 40, text: "世界" },
        ],
        [{ start: 10, end: 40, text: "你好，世界！" }],
      ),
    ).toBe(true)
  })

  it("rejects a cue that incorrectly holds text across a long silence", () => {
    expect(
      isSegmentationAligned(
        [
          { start: 0, end: 1000, text: "Hello" },
          { start: 10000, end: 11000, text: "world" },
        ],
        [{ start: 0, end: 11000, text: "Hello world." }],
      ),
    ).toBe(false)
  })
})
