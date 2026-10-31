import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AttemptContext } from "../attempt-context"
import { BatchQueue, BatchCountMismatchError } from "../batch-queue"
import { getExecutionContext } from "../execution-context"
import { RequestQueue } from "../request-queue"
import { resolveResourcePolicy } from "../resource-policy"
import { ResourceScheduler } from "../resource-scheduler"

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function setup(overrides = {}) {
  const policy = resolveResourcePolicy({ baseRetryDelayMs: 100, ...overrides })
  const scheduler = new ResourceScheduler()
  scheduler.configure([{ id: "account", policy }], new Map([["account", ["account"]]]))
  const queue = new RequestQueue({
    timeoutMs: policy.timeoutMs,
    maxRetries: policy.maxAttempts - 1,
    baseRetryDelayMs: 100,
    maxQueued: 256,
  })
  const remote = <T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>) => {
    const context = getExecutionContext(signal)!
    context.policy ??= policy
    let settle!: () => void
    context.physicalSettled = new Promise<void>((r) => {
      settle = r
    })
    return scheduler.run(
      {
        resourceId: "account",
        consumer: context.consumer,
        priority: context.priority,
        signal,
        attempts: context.attempts,
        onSettled: settle,
        onAbort: context.abort,
      },
      async (activeSignal, permit) => {
        permit.start()
        return run(activeSignal)
      },
    )
  }
  return { queue, scheduler, remote }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.spyOn(Math, "random").mockReturnValue(0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("logical queue with the single physical scheduler", () => {
  it("does not acquire remote permits for local/cache work", async () => {
    const { queue, scheduler } = setup()
    await expect(queue.enqueue(async () => "cached", 0, "cache")).resolves.toBe("cached")
    expect(scheduler.inspect().counters.starts).toBe(0)
  })
  it("deduplicates subscribers and shares consumed member attempts", async () => {
    const { queue, remote, scheduler } = setup()
    const first = AttemptContext.create(["member"]),
      late = AttemptContext.create(["member"])
    const done = deferred<string>()
    const a = queue.enqueue((s) => remote(s, () => done.promise), 0, "hash", ["a"], {
      attempts: first,
    })
    const b = queue.enqueue((s) => remote(s, async () => "wrong"), 0, "hash", ["b"], {
      attempts: late,
    })
    queue.cancelByScope("a")
    expect(late.counts).toEqual([1])
    done.resolve("shared")
    expect(await a).toBe(await b)
    await flush()
    expect(scheduler.counters.starts).toBe(1)
  })
  it("keeps cancelled physical work as a tombstone until actual termination", async () => {
    const { queue, remote, scheduler } = setup({ maxInFlight: 1 })
    const done = deferred<string>()
    const a = queue.enqueue((s) => remote(s, () => done.promise), 0, "hash", ["a"])
    const rejected = a.catch((error) => error)
    queue.cancelByScope("a")
    const duplicate = queue
      .enqueue((s) => remote(s, async () => "duplicate"), 0, "hash", ["b"])
      .catch((error) => error)
    expect(await duplicate).toBe(await rejected)
    expect(scheduler.inspect().active).toBe(1)
    done.resolve("obsolete")
    await flush()
    await expect(
      queue.enqueue((s) => remote(s, async () => "fresh"), 0, "hash", ["c"]),
    ).resolves.toBe("fresh")
    expect(scheduler.counters.starts).toBe(2)
  })
  it("honors scheduleAt and cancels scheduled work without starting it", async () => {
    const { queue, remote, scheduler } = setup()
    const a = queue.enqueue((s) => remote(s, async () => "no"), 1000, "a", ["a"]).catch((e) => e)
    const b = queue.enqueue((s) => remote(s, async () => "yes"), 500, "b", ["b"])
    queue.cancelByScope("a")
    await vi.advanceTimersByTimeAsync(499)
    expect(scheduler.counters.starts).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(await b).toBe("yes")
    await a
    await vi.advanceTimersByTimeAsync(1000)
    expect(scheduler.counters.starts).toBe(1)
  })
  it.each([401, 403, 400, 404])(
    "fails HTTP %s without draining unrelated work",
    async (statusCode) => {
      const { queue, remote, scheduler } = setup()
      const failed = queue
        .enqueue(
          (s) =>
            remote(s, async () => {
              throw Object.assign(new Error("denied"), { statusCode })
            }),
          0,
          "bad",
        )
        .catch((e) => e)
      expect(await queue.enqueue((s) => remote(s, async () => "ok"), 0, "good")).toBe("ok")
      expect((await failed).statusCode).toBe(statusCode)
      await vi.advanceTimersByTimeAsync(10000)
      expect(scheduler.counters.starts).toBe(2)
    },
  )
  it.each([429, 503, 408])(
    "HTTP %s uses at most three total physical attempts",
    async (statusCode) => {
      const { queue, remote, scheduler } = setup()
      const failed = queue
        .enqueue(
          (s) =>
            remote(s, async () => {
              throw Object.assign(new Error("retry"), { statusCode })
            }),
          0,
          "bad",
        )
        .catch((e) => e)
      await vi.advanceTimersByTimeAsync(30000)
      expect((await failed).statusCode).toBe(statusCode)
      expect(scheduler.counters.starts).toBe(3)
      expect(scheduler.inspect()).toMatchObject({ active: 0, queued: 0, timers: 0 })
    },
  )
  it("cancels during retry delay and never starts a later attempt", async () => {
    const { queue, remote, scheduler } = setup()
    const failed = queue
      .enqueue(
        (s) =>
          remote(s, async () => {
            throw new Error("network error")
          }),
        0,
        "bad",
        ["play"],
      )
      .catch((e) => e)
    await flush()
    queue.cancelByScope("play")
    await vi.advanceTimersByTimeAsync(30000)
    await failed
    expect(scheduler.counters.starts).toBe(1)
  })
  it("bounds queued logical work and accepts capacity edits without dropping existing work", async () => {
    const { queue } = setup()
    queue.setQueueOptions({ maxQueued: 2 })
    const a = queue.enqueue(async () => "a", 1000, "a")
    const b = queue.enqueue(async () => "b", 1000, "b")
    queue.setQueueOptions({ maxQueued: 1 })
    await expect(queue.enqueue(async () => "c", 1000, "c")).rejects.toThrow("queue-full")
    await vi.advanceTimersByTimeAsync(1000)
    expect(await Promise.all([a, b])).toEqual(["a", "b"])
    expect(() => queue.setQueueOptions({ maxQueued: -1 })).toThrow("input-limit")
    expect(() => queue.setQueueOptions({ maxRetries: Infinity })).toThrow("input-limit")
  })
  it("recovers N malformed members within 1 + N*(R-1) actual calls", async () => {
    const { queue, remote, scheduler } = setup()
    const contexts: AttemptContext[] = []
    const batch = new BatchQueue<string, string>({
      maxItemsPerBatch: 5,
      maxCharactersPerBatch: 100,
      batchDelay: 100,
      getBatchKey: () => "same",
      getDedupKey: (x) => x,
      getCharacters: (x) => x.length,
      executeBatch: (items, meta) =>
        queue.enqueue(
          (s) =>
            remote(s, async () => {
              throw new BatchCountMismatchError(items.length, 0, [])
            }),
          0,
          "batch",
          meta.scopes,
          { attempts: meta.attempts },
        ),
      executeIndividual: (item, meta) => {
        contexts.push(meta.attempts)
        return queue.enqueue(
          (s) =>
            remote(s, async () => {
              throw Object.assign(new Error("server"), { statusCode: 503 })
            }),
          0,
          item,
          meta.scopes,
          { attempts: meta.attempts },
        )
      },
    })
    const results = Promise.allSettled(["a", "b", "c", "d", "e"].map((x) => batch.enqueue(x)))
    await vi.advanceTimersByTimeAsync(10000)
    expect((await results).every((r) => r.status === "rejected")).toBe(true)
    expect(scheduler.counters.starts).toBe(11)
    expect(contexts.map((c) => c.counts)).toEqual([[3], [3], [3], [3], [3]])
  })
  it.each([401, 403, 429, 408, 503])("never splits HTTP %s failures", async (statusCode) => {
    const { queue, remote, scheduler } = setup()
    const individual = vi.fn<() => Promise<string>>(async () => "unexpected")
    const batch = new BatchQueue<string, string>({
      maxItemsPerBatch: 5,
      maxCharactersPerBatch: 100,
      batchDelay: 100,
      getBatchKey: () => "same",
      getDedupKey: (x) => x,
      getCharacters: (x) => x.length,
      executeBatch: (_items, meta) =>
        queue.enqueue(
          (s) =>
            remote(s, async () => {
              throw Object.assign(new Error("HTTP"), { statusCode })
            }),
          0,
          "batch",
          meta.scopes,
          { attempts: meta.attempts },
        ),
      executeIndividual: individual,
    })
    const results = Promise.allSettled(["a", "b", "c", "d", "e"].map((x) => batch.enqueue(x)))
    await vi.advanceTimersByTimeAsync(30000)
    await results
    expect(individual).not.toHaveBeenCalled()
    expect(scheduler.counters.starts).toBe(statusCode === 401 || statusCode === 403 ? 1 : 3)
  })
  it("retains aligned successes and spends attempts/physical permits only on failed members", async () => {
    const { queue, remote, scheduler } = setup()
    let attempts!: AttemptContext
    const fallback = vi.fn<
      (item: string, meta: import("../batch-queue").BatchExecutionMeta) => Promise<never>
    >((item: string, meta: import("../batch-queue").BatchExecutionMeta) =>
      queue.enqueue(
        (signal) =>
          remote(signal, async () => {
            throw Object.assign(new Error("server"), { statusCode: 503 })
          }),
        0,
        item,
        meta.scopes,
        { attempts: meta.attempts },
      ),
    )
    const batch = new BatchQueue<string, unknown>({
      maxItemsPerBatch: 5,
      maxCharactersPerBatch: 100,
      batchDelay: 100,
      getBatchKey: () => "same",
      getDedupKey: (x) => x,
      getCharacters: (x) => x.length,
      isResultValid: (result) => typeof result === "string" && !!result.trim(),
      executeBatch: (_items, meta) => {
        attempts = meta.attempts
        return queue.enqueue(
          (signal) => remote(signal, async () => ["A", " ", "C", { invalid: true }, "E"]),
          0,
          "batch",
          meta.scopes,
          { attempts: meta.attempts },
        )
      },
      executeIndividual: fallback,
    })
    const outcomes = Promise.allSettled(["a", "b", "c", "d", "e"].map((x) => batch.enqueue(x)))
    await vi.advanceTimersByTimeAsync(10000)
    expect((await outcomes).map((r) => (r.status === "fulfilled" ? r.value : "failed"))).toEqual([
      "A",
      "failed",
      "C",
      "failed",
      "E",
    ])
    expect(fallback.mock.calls.map(([item]) => item)).toEqual(["b", "d"])
    expect(attempts.counts).toEqual([1, 3, 1, 3, 1])
    expect(scheduler.counters.starts).toBe(5) // 1 + failedMembers * (maxAttempts - 1)
    expect(scheduler.inspect().active).toBe(0)
  })
  it("rejects invalid singleton recovery without minting another batch or accepting blank output", async () => {
    const individual = vi.fn<(item: string) => Promise<string>>(async () => " ")
    const batch = new BatchQueue<string, string>({
      maxItemsPerBatch: 2,
      maxCharactersPerBatch: 100,
      batchDelay: 100,
      getBatchKey: () => "same",
      getCharacters: (x) => x.length,
      isResultValid: (result) => !!result.trim(),
      executeBatch: async () => ["ok", ""],
      executeIndividual: individual,
    })
    const results = Promise.allSettled([batch.enqueue("good"), batch.enqueue("bad")])
    await vi.advanceTimersByTimeAsync(1000)
    expect((await results).map((r) => r.status)).toEqual(["fulfilled", "rejected"])
    expect(individual).toHaveBeenCalledTimes(1)
    expect(individual.mock.calls[0]?.[0]).toBe("bad")
  })
})
