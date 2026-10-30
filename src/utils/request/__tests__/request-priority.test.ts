import { afterEach, describe, expect, it, vi } from "vitest"
import { RequestQueue } from "../request-queue"

function queue() {
  return new RequestQueue(
    { rate: 100, capacity: 1, timeoutMs: 1000, maxRetries: 0, baseRetryDelayMs: 10 },
    30_000,
  )
}
afterEach(() => vi.useRealTimers())
describe("subtitle queue priority and aging", () => {
  it("dispatches current cues before waiting export work without preempting executing work", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const q = queue(),
      order: string[] = []
    const submit = (key: string, priority: number) =>
      q.enqueue(
        async () => {
          order.push(key)
          return key
        },
        100,
        key,
        [key],
        { priority },
      )
    const tasks = [submit("export", 3), submit("prefetch", 2), submit("current", 0)]
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all(tasks)
    expect(order).toEqual(["current", "prefetch", "export"])
  })
  it("ages auxiliary work ahead of new current cues while respecting scheduleAt", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const q = queue(),
      order: string[] = []
    const old = q.enqueue(
      async () => {
        order.push("old export")
      },
      100_000,
      "old",
      ["old"],
      { priority: 3 },
    )
    await vi.advanceTimersByTimeAsync(99_999)
    expect(order).toEqual([])
    const current = q.enqueue(
      async () => {
        order.push("current")
      },
      100_000,
      "new",
      ["new"],
      { priority: 0 },
    )
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([old, current])
    expect(order).toEqual(["old export", "current"])
  })
  it("promotes a shared pending request and keeps it alive for the other subscriber", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const q = queue(),
      order: string[] = []
    const run = vi.fn<() => Promise<string>>(async () => {
      order.push("shared")
      return "same result"
    })
    const old = q.enqueue(run, 100, "same", ["export"], { priority: 3 })
    const next = q.enqueue(run, 100, "same", ["playback"], { priority: 0 })
    const other = q.enqueue(
      async () => {
        order.push("prefetch")
      },
      100,
      "other",
      ["other"],
      { priority: 2 },
    )
    q.cancelByScope("export")
    await vi.advanceTimersByTimeAsync(200)
    expect(await old).toBe(await next)
    await other
    expect(order).toEqual(["shared", "prefetch"])
    expect(run).toHaveBeenCalledTimes(1)
  })
})
