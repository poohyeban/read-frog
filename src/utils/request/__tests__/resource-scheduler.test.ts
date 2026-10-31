import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { vi } from "vitest"
import { resolveResourcePolicy } from "../resource-policy"
import { ResourceScheduler, type ResourceDomainSpec } from "../resource-scheduler"
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const spec = (id: string, maxInFlight = 2, rate = 8, capacity = 20): ResourceDomainSpec => ({
  id,
  policy: resolveResourcePolicy({ maxInFlight, rate, capacity }),
})
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe("single physical resource authority", () => {
  it("shares actual concurrency and token bucket across business consumers", async () => {
    const s = new ResourceScheduler()
    s.configure([spec("key", 1, 1, 1)], new Map([["key", ["key"]]]))
    const first = deferred()
    let starts = 0
    const a = s.run({ resourceId: "key", consumer: "page" }, async (_signal, permit) => {
      permit.start()
      starts++
      await first.promise
    })
    const b = s.run({ resourceId: "key", consumer: "subtitles" }, async (_signal, permit) => {
      permit.start()
      starts++
    })
    expect(starts).toBe(1)
    first.resolve()
    await a
    await flush()
    expect(starts).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    await b
    await flush()
    expect(starts).toBe(2)
    expect(s.inspect()).toMatchObject({ active: 0, queued: 0, lanes: 0, timers: 0 })
  })
  it("never consumes credential tokens or slots while a shared domain is unavailable", async () => {
    const s = new ResourceScheduler()
    s.configure(
      [spec("a"), spec("b"), spec("group", 1)],
      new Map([
        ["a", ["a", "group"]],
        ["b", ["b", "group"]],
      ]),
    )
    const held = deferred()
    const a = s.run({ resourceId: "a", consumer: "page" }, async (_signal, p) => {
      p.start()
      await held.promise
    })
    const b = s.run({ resourceId: "b", consumer: "fast" }, async (_signal, p) => p.start())
    expect(s.inspect().domains.b).toMatchObject({ active: 0, tokens: 20 })
    held.resolve()
    await a
    await b
    await flush()
    expect(s.inspect().domains.b!.tokens).toBe(19)
    expect(s.inspect().domains.group!.tokens).toBe(18)
  })
  it("holds an uncooperative operation after Abort and releases exactly once at completion", async () => {
    const s = new ResourceScheduler()
    s.configure([spec("a", 1)], new Map([["a", ["a"]]]))
    const controller = new AbortController(),
      held = deferred()
    const a = s.run(
      { resourceId: "a", consumer: "stream", signal: controller.signal },
      async (_signal, p) => {
        p.start()
        await held.promise
      },
    )
    const rejected = a.catch((error) => error)
    controller.abort(new Error("stop"))
    expect((await rejected).message).toBe("stop")
    let nextStarted = false
    const b = s.run({ resourceId: "a", consumer: "fast" }, async (_signal, p) => {
      p.start()
      nextStarted = true
    })
    await flush()
    expect(nextStarted).toBe(false)
    expect(s.inspect().active).toBe(1)
    held.resolve()
    await b
    await flush()
    expect(s.inspect().active).toBe(0)
    expect(s.counters.starts).toBe(2)
  })
  it("merges running identities without forgetting old occupancy or granting a free burst", async () => {
    const s = new ResourceScheduler()
    const aDone = deferred(),
      bDone = deferred()
    s.configure(
      [spec("a"), spec("b")],
      new Map([
        ["a", ["a"]],
        ["b", ["b"]],
      ]),
    )
    const a = s.run({ resourceId: "a", consumer: "a" }, async (_signal, p) => {
      p.start()
      await aDone.promise
    })
    const b = s.run({ resourceId: "b", consumer: "b" }, async (_signal, p) => {
      p.start()
      await bDone.promise
    })
    s.configure(
      [spec("a"), spec("b"), spec("group", 1)],
      new Map([
        ["a", ["a", "group"]],
        ["b", ["b", "group"]],
      ]),
    )
    expect(s.inspect().domains.group).toMatchObject({ active: 2, tokens: 0 })
    let starts = 0
    const c = s.run({ resourceId: "b", consumer: "c" }, async (_signal, p) => {
      p.start()
      starts++
    })
    await vi.advanceTimersByTimeAsync(1000)
    aDone.resolve()
    await a
    await flush()
    expect(starts).toBe(0)
    bDone.resolve()
    await b
    await c
    await flush()
    expect(starts).toBe(1)
  })
  it("prioritizes current captions centrally and lets old ordinary work age into service", async () => {
    const s = new ResourceScheduler()
    s.configure([spec("a", 1)], new Map([["a", ["a"]]]))
    const held = deferred(),
      order: string[] = []
    const active = s.run({ resourceId: "a", consumer: "held" }, async (_signal, p) => {
      p.start()
      await held.promise
    })
    const quality = s.run(
      { resourceId: "a", consumer: "quality", priority: 3 },
      async (_signal, p) => {
        p.start()
        order.push("quality")
      },
    )
    const fast = s.run({ resourceId: "a", consumer: "fast", priority: 0 }, async (_signal, p) => {
      p.start()
      order.push("fast")
    })
    held.resolve()
    await flush()
    expect(s.inspect()).toMatchObject({ queued: 0, active: 0 })
    await Promise.all([active, quality, fast])
    expect(order).toEqual(["fast", "quality"])
    const second = deferred()
    const running = s.run({ resourceId: "a", consumer: "held" }, async (_signal, p) => {
      p.start()
      await second.promise
    })
    const old = s.run({ resourceId: "a", consumer: "page", priority: 2 }, async (_signal, p) => {
      p.start()
      order.push("page")
    })
    await vi.advanceTimersByTimeAsync(90_000)
    const fresh = s.run({ resourceId: "a", consumer: "fast", priority: 0 }, async (_signal, p) => {
      p.start()
      order.push("new-fast")
    })
    second.resolve()
    await flush()
    expect(s.inspect()).toMatchObject({ queued: 0, active: 0 })
    await Promise.all([running, old, fresh])
    expect(order.slice(-2)).toEqual(["page", "new-fast"])
  })
  it("scopes shared cooldown to its group and leaves unrelated identities running", async () => {
    const s = new ResourceScheduler()
    s.configure(
      [spec("a"), spec("b"), spec("c"), spec("group")],
      new Map([
        ["a", ["a", "group"]],
        ["b", ["b", "group"]],
        ["c", ["c"]],
      ]),
    )
    s.cool("a", 1000)
    let started = false
    const b = s.run({ resourceId: "b", consumer: "b" }, async (_signal, p) => {
      p.start()
      started = true
    })
    await s.run({ resourceId: "c", consumer: "c" }, async (_signal, p) => p.start())
    expect(started).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await b
    expect(started).toBe(true)
  })
  it("does not charge a local validation failure and never starts a revoked task", async () => {
    const s = new ResourceScheduler()
    s.configure([spec("a")], new Map([["a", ["a"]]]))
    await expect(
      s.run({ resourceId: "a", consumer: "local" }, async () => {
        throw new Error("invalid input")
      }),
    ).rejects.toThrow("invalid input")
    await flush()
    expect(s.inspect().domains.a!.tokens).toBe(20)
    expect(s.counters.starts).toBe(0)
    await expect(
      s.run(
        {
          resourceId: "a",
          consumer: "revoked",
          assertCurrent: () => {
            throw new Error("lease revoked")
          },
        },
        async (_signal, p) => p.start(),
      ),
    ).rejects.toThrow("lease revoked")
    expect(s.counters.starts).toBe(0)
  })
})

it("applies lower concurrency and new rates without cancelling or duplicating running operations", async () => {
  const scheduler = new ResourceScheduler()
  const paths = new Map([["a", ["a"]]])
  scheduler.configure([spec("a", 4, 8, 4)], paths)
  const blockers = Array.from({ length: 4 }, () => deferred())
  const active = blockers.map((done, i) =>
    scheduler.run({ resourceId: "a", consumer: `tab-${i}` }, async (_s, permit) => {
      permit.start()
      await done.promise
    }),
  )
  expect(scheduler.counters.starts).toBe(4)
  scheduler.configure([spec("a", 1, 2, 20)], paths)
  expect(scheduler.inspect().domains.a).toMatchObject({ active: 4, tokens: 0 })
  let nextStarted = false
  const next = scheduler.run(
    { resourceId: "a", consumer: "urgent", priority: 0 },
    async (_s, p) => {
      p.start()
      nextStarted = true
    },
  )
  await vi.advanceTimersByTimeAsync(1000)
  for (const done of blockers.slice(0, 3)) done.resolve()
  await flush()
  expect(nextStarted).toBe(false)
  blockers[3]!.resolve()
  await Promise.all(active)
  await next
  await flush()
  expect(scheduler.counters.starts).toBe(5)
  expect(scheduler.inspect()).toMatchObject({ active: 0, queued: 0, timers: 0 })
})

it("supports fractional rates and capacity edits without replenishing the bucket", async () => {
  const scheduler = new ResourceScheduler(),
    starts: number[] = [],
    paths = new Map([["a", ["a"]]])
  scheduler.configure([spec("a", 2, 0.25, 1)], paths)
  await scheduler.run({ resourceId: "a", consumer: "first" }, async (_s, p) => {
    p.start()
    starts.push(Date.now())
  })
  await flush()
  const next = scheduler.run({ resourceId: "a", consumer: "second" }, async (_s, p) => {
    p.start()
    starts.push(Date.now())
  })
  await vi.advanceTimersByTimeAsync(2000)
  scheduler.configure([spec("a", 2, 0.25, 100)], paths)
  expect(scheduler.inspect().domains.a!.tokens).toBe(0.5)
  await vi.advanceTimersByTimeAsync(1999)
  expect(starts).toEqual([0])
  await vi.advanceTimersByTimeAsync(1)
  await next
  expect(starts).toEqual([0, 4000])
})

it("promotes a queued shared task when its current-caption subscriber joins", async () => {
  const scheduler = new ResourceScheduler(),
    done = deferred(),
    order: string[] = []
  scheduler.configure([spec("a", 1)], new Map([["a", ["a"]]]))
  const active = scheduler.run({ resourceId: "a", consumer: "active" }, async (_s, p) => {
    p.start()
    await done.promise
  })
  const ordinary = scheduler.run(
    { resourceId: "a", consumer: "page", priority: 1 },
    async (_s, p) => {
      p.start()
      order.push("page")
    },
  )
  let promote!: (priority: number) => void
  const shared = scheduler.run(
    {
      resourceId: "a",
      consumer: "export",
      priority: 3,
      onQueued: (callback) => {
        promote = callback
      },
    },
    async (_s, p) => {
      p.start()
      order.push("shared")
    },
  )
  promote(0)
  done.resolve()
  await Promise.all([active, ordinary, shared])
  expect(order).toEqual(["shared", "page"])
})
