import { describe, expect, it } from "vitest"
import { AttemptContext } from "../attempt-context"

describe("member attempt conservation", () => {
  it.each([1, 5, 32])("permits every one of %i members its remaining fallback attempts", (n) => {
    const ids = Array.from({ length: n }, (_, i) => `member-${i}`)
    const batch = AttemptContext.create(ids)
    batch.start(3)
    let physicalStarts = 1
    for (const id of ids) {
      const member = batch.subset([id])
      for (let i = 0; i < 2; i++) {
        member.start(3)
        physicalStarts++
      }
      expect(() => member.start(3)).toThrow("attempts")
    }
    expect(physicalStarts).toBe(1 + n * 2)
    expect(batch.counts).toEqual(Array(n).fill(3))
  })
  it("does not partially charge a batch containing an exhausted member", () => {
    const group = AttemptContext.create(["a", "b"])
    group.subset(["a"]).start(1)
    expect(() => group.start(3)).toThrow("attempts")
    expect(group.counts).toEqual([1, 0])
  })
  it("honors lower live limits without granting extra attempts when limits are raised", () => {
    const task = AttemptContext.create(["caption"])
    task.start(3)
    expect(task.canStart(1)).toBe(false)
    expect(() => task.start(1)).toThrow("attempts")
    task.start(2)
    expect(() => task.start(10)).toThrow("attempts")
    expect(task.counts).toEqual([2])
  })
  it("cannot mint attempts by renaming members or changing runtime policy", () => {
    const group = AttemptContext.create(["a", "a"])
    group.start(1)
    expect(() => group.subset(["b"])).toThrow("input-limit")
    expect(() => group.start(10)).toThrow("attempts")
    expect(group.counts).toEqual([1])
  })
})
