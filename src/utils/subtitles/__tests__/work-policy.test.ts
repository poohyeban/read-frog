import { describe, expect, it } from "vitest"
import { continuousReadyMs, SubtitleBufferController } from "../continuous-buffer"
import {
  chunkSubtitleWork,
  assertSubtitleWindow,
  subtitleOutputLimit,
  SUBTITLE_WORK_LIMITS,
} from "../work-policy"

describe("independent model input boundaries", () => {
  it("chunks three hours, dense captions, oversized cues and long timestamps without losing text", () => {
    const source = Array.from({ length: 5400 }, (_, i) => ({
      start: i * 2000,
      end: i * 2000 + 1800,
      text: `Source ${i}.`,
    }))
    source.push({ start: 10_800_000, end: 11_000_000, text: "长".repeat(10000) })
    const chunks = chunkSubtitleWork(source)
    expect(chunks.length).toBeGreaterThan(180)
    for (const chunk of chunks) expect(() => assertSubtitleWindow(chunk)).not.toThrow()
    expect(
      chunks
        .flat()
        .map((c) => c.text)
        .join(""),
    ).toBe(source.map((c) => c.text).join(""))
    expect(() => assertSubtitleWindow(source)).toThrow("input-limit")
    expect(subtitleOutputLimit("hello", true)).toBeLessThan(512)
    expect(subtitleOutputLimit("a".repeat(10000), true)).toBe(SUBTITLE_WORK_LIMITS.outputTokens)
  })
  it("does not sum disjoint readiness, and treats true silence as covered", () => {
    const source = [0, 2000, 10000].map((start) => ({ start, end: start + 1000, text: "speech" }))
    const ready = [source[0]!, source[2]!].map((c) => ({ ...c, translation: "译文" }))
    expect(continuousReadyMs(source, ready, 0, 15000)).toBe(2000)
    expect(
      continuousReadyMs(source, [...ready, { ...source[1]!, translation: "译文" }], 0, 15000),
    ).toBe(15000)
  })
  it("measures the union when dense source cues overlap or nest", () => {
    const source = [
      { start: 0, end: 2000, text: "long" },
      { start: 100, end: 600, text: "nested" },
    ]
    const ready = [
      { start: 0, end: 500, text: "a", translation: "a" },
      { start: 500, end: 2000, text: "b", translation: "b" },
    ]
    expect(continuousReadyMs(source, ready, 0, 2000)).toBe(2000)
  })
  it("uses different suspend/resume watermarks and accounts for playback rate", () => {
    const buffer = new SubtitleBufferController()
    expect(buffer.update(21000)).toBe(false)
    for (let i = 0; i < 100; i++) expect(buffer.update(i % 2 ? 19000 : 21000)).toBe(false)
    expect(buffer.update(7000)).toBe(true)
    expect(buffer.update(21000, 4)).toBe(true)
    expect(buffer.update(80000, 4)).toBe(false)
  })
})
