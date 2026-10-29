import { afterEach, describe, expect, it, vi } from "vitest"
import { RequestQueue } from "../request-queue"

const options = { rate: 1000, capacity: 20, timeoutMs: 1000, maxRetries: 2, baseRetryDelayMs: 10 }
afterEach(() => vi.useRealTimers())

describe("independent request concurrency", () => {
  it("holds only executing attempts in slots independently of burst capacity", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue({ ...options, maxConcurrent: 2 })
    let running = 0
    let peak = 0
    const results = Array.from({ length: 12 }, (_, i) =>
      queue.enqueue(
        async () => {
          running++
          peak = Math.max(peak, running)
          await new Promise((resolve) => setTimeout(resolve, 20))
          running--
          return i
        },
        Date.now(),
        String(i),
      ),
    )
    expect(running).toBe(2)
    expect(queue.nextDispatchEtaMs()).toBe(Infinity)
    await vi.runAllTimersAsync()
    expect(await Promise.all(results)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(peak).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("allows concurrency above a small burst capacity without changing token rate", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue({ ...options, capacity: 1, maxConcurrent: 2 })
    let started = 0
    const results = Array.from({ length: 3 }, (_, i) =>
      queue.enqueue(
        async () => {
          started++
          await new Promise((resolve) => setTimeout(resolve, 20))
        },
        Date.now(),
        String(i),
      ),
    )
    expect(started).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(started).toBe(2)
    await vi.runAllTimersAsync()
    await Promise.all(results)
  })

  it("resumes a 429 cooldown with one probe, not a full bucket", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue({
      ...options,
      rate: 1,
      retryPolicy: {
        decide: () => ({ action: "pause-and-retry", pauseMs: 5000 }),
      },
    })
    let calls = 0
    const task = queue.enqueue(
      async () => {
        if (calls++ === 0) throw new Error("429")
        return "ok"
      },
      Date.now(),
      "limited",
    )
    await vi.advanceTimersByTimeAsync(0)
    let otherCalls = 0
    const others = Array.from({ length: 3 }, (_, i) =>
      queue.enqueue(
        async () => {
          otherCalls++
        },
        Date.now(),
        `other-${i}`,
      ),
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(otherCalls + calls - 1).toBe(1)
    await vi.runAllTimersAsync()
    await Promise.all([task, ...others])
  })

  it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid concurrency %s", (maxConcurrent) => {
    expect(() => new RequestQueue({ ...options, maxConcurrent })).toThrow(/positive integer/)
    expect(() => new RequestQueue(options).setQueueOptions({ maxConcurrent })).toThrow(
      /positive integer/,
    )
  })

  it("leaves the existing unlimited behavior when no limit is supplied", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue(options)
    let started = 0
    const results = Array.from({ length: 12 }, (_, i) =>
      queue.enqueue(
        async () => {
          started++
          await new Promise((resolve) => setTimeout(resolve, 20))
        },
        Date.now(),
        String(i),
      ),
    )
    expect(started).toBe(12)
    await vi.runAllTimersAsync()
    await Promise.all(results)
  })

  it("does not occupy a slot during retry backoff", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue({
      ...options,
      maxConcurrent: 1,
      retryPolicy: {
        decide: (_error, context) =>
          context.retryCount === 0 ? { action: "retry", delayMs: 100 } : { action: "fail" },
      },
    })
    let attempts = 0
    const order: string[] = []
    const first = queue.enqueue(
      async () => {
        order.push("first")
        if (attempts++ === 0) throw new Error("retry")
        return "ok"
      },
      Date.now(),
      "first",
    )
    const second = queue.enqueue(
      async () => {
        order.push("second")
        return "ok"
      },
      Date.now(),
      "second",
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(["first", "second"])
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(order).toEqual(["first", "second", "first"])
  })

  it("never overlaps a timed-out transport that ignores cancellation with a retry", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue({ ...options, maxConcurrent: 1, timeoutMs: 10 })
    const thunk = vi.fn<() => Promise<string>>(() => new Promise(() => {}))
    const task = queue.enqueue(thunk, Date.now(), "uncooperative")
    void task.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(task).rejects.toThrow(/timed out/)
    expect(thunk).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(queue.enqueue(async () => "next", Date.now(), "next")).resolves.toBe("next")
  })

  it("cancellation releases exactly one attempt even when the cancelled promise settles late", async () => {
    vi.useFakeTimers()
    const queue = new RequestQueue({ ...options, maxConcurrent: 1 })
    let finishOld!: (value: string) => void
    const old = queue.enqueue(
      () =>
        new Promise<string>((resolve) => {
          finishOld = resolve
        }),
      Date.now(),
      "shared",
      ["old"],
    )
    void old.catch(() => {})
    queue.cancelByScope("old")
    await expect(old).rejects.toThrow(/cancelled/i)
    const starts: string[] = []
    const current = queue.enqueue(
      async () => {
        starts.push("current")
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
      Date.now(),
      "shared",
      ["new"],
    )
    const next = queue.enqueue(
      async () => {
        starts.push("next")
      },
      Date.now(),
      "next",
    )
    await vi.advanceTimersByTimeAsync(0)
    finishOld("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toEqual(["current"])
    await vi.runAllTimersAsync()
    await Promise.all([current, next])
    expect(starts).toEqual(["current", "next"])
  })
})
