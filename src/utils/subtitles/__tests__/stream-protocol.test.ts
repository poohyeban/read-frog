import { describe, expect, it } from "vitest"
import { SubtitleStreamParser } from "../stream-protocol"
const row = (id: number, text = `T${id}`) => JSON.stringify({ v: 1, id, text }) + "\n"
describe("subtitle NDJSON stream protocol", () => {
  it("accepts every chunk boundary, escaped newlines and literal separator characters", () => {
    const input = row(0, "one%percent\\n你好") + row(1, "two\nlines") + row(2)
    for (let cut = 0; cut <= input.length; cut++) {
      const parser = new SubtitleStreamParser(3)
      const partial = [...parser.push(input.slice(0, cut)), ...parser.push(input.slice(cut))]
      expect(partial.map((p) => p.id)).toEqual([0, 1, 2])
      expect(parser.finish()).toEqual(["one%percent\\n你好", "two\nlines", "T2"])
    }
    const parser = new SubtitleStreamParser(3)
    for (const char of input) parser.push(char)
    expect(parser.finish()[2]).toBe("T2")
  })
  it("uses explicit IDs for missing, out-of-order and empty members", () => {
    const parser = new SubtitleStreamParser(4)
    expect(parser.push(row(2) + row(0, ""))).toEqual([
      { id: 2, text: "T2" },
      { id: 0, text: "" },
    ])
    expect(parser.finish()).toEqual(["", "", "T2", ""])
  })
  it.each([
    row(0) + row(0),
    row(4),
    row(-1),
    row(0, "<think>secret</think>answer"),
    row(0, "a\n%%\nb"),
    "{}\n",
    "ordinary % text\n",
    '{"v":1,"id":0,"text":3}\n',
  ])("rejects invalid protocol without retry permission: %s", (input) => {
    expect(() => new SubtitleStreamParser(3).push(input)).toThrow("Subtitle stream:")
  })
  it("retains complete indexed members when a length finish truncates the final record", () => {
    const parser = new SubtitleStreamParser(3)
    parser.push(row(0) + row(2) + '{"v":1,"id":1,"text":"unfinished')
    expect(parser.finish(true)).toEqual(["T0", "", "T2"])
    const invalid = new SubtitleStreamParser(3)
    invalid.push(row(0) + '{"v":1,"id":0,"text":"duplicate"}')
    expect(() => invalid.finish(true)).toThrow("duplicate")
  })
  it("bounds unterminated lines, cumulative responses and incomplete final JSON", () => {
    expect(() => new SubtitleStreamParser(1).push("x".repeat(8193))).toThrow("line limit")
    expect(() => new SubtitleStreamParser(1).push("x".repeat(65537))).toThrow("response limit")
    const parser = new SubtitleStreamParser(1)
    parser.push('{"v":1')
    expect(() => parser.finish()).toThrow("invalid JSON")
  })
})
