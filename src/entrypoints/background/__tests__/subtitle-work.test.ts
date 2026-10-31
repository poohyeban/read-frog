import { beforeEach, describe, expect, it, vi } from "vitest"
const fixture = vi.hoisted(() => ({
  budgets: new Map<string, any>(),
  attempts: new Map<string, any>(),
  tail: Promise.resolve(),
  limits: {
    requests: 3,
    estimatedTokens: 100000,
    emergencyPercent: 0,
    maxInFlight: 1,
    diagnostics: true,
  },
}))
vi.mock("../config", () => ({
  ensureInitializedConfig: async () => ({ videoSubtitles: { workBudget: fixture.limits } }),
}))
vi.mock("@/utils/db/dexie/db", () => {
  const table = (map: Map<string, any>) => ({
    get: async (key: string) => structuredClone(map.get(key)),
    put: async (row: any) => {
      map.set(row.key, structuredClone(row))
    },
    bulkPut: async (rows: any[]) => {
      for (const row of rows) map.set(row.key, structuredClone(row))
    },
  })
  return {
    db: {
      subtitleBudget: table(fixture.budgets),
      subtitleAttempt: table(fixture.attempts),
      transaction: (...args: any[]) => {
        const operation = fixture.tail.then(args.at(-1))
        fixture.tail = operation.catch(() => {})
        return operation
      },
    },
  }
})
import { SubtitleWorkRuntime } from "../subtitle-work"

function subscriber(
  runtime: SubtitleWorkRuntime,
  id: number,
  lane: "fast" | "quality" = "fast",
  urgent = true,
) {
  const lease = runtime.open(id)
  const scope = `${id}:task`
  runtime.register(id, scope, { lease, lane, urgent, logicalKey: scope, start: 0, end: 1000 })
  return { lease, scope, guard: runtime.guard(() => [scope], [scope]) }
}
beforeEach(() => {
  fixture.budgets.clear()
  fixture.attempts.clear()
  fixture.tail = Promise.resolve()
  fixture.limits.requests = 3
  fixture.limits.emergencyPercent = 0
})
describe("persistent dispatch boundary", () => {
  it("bounds diagnostic retention and never serializes prompt content or lease credentials", async () => {
    const runtime = new SubtitleWorkRuntime(),
      a = subscriber(runtime, 1)
    expect(runtime.snapshot().events).toEqual([])
    await a.guard.beforeCall("PRIVATE caption with api-secret", 128)
    a.guard.onDispatch?.()
    await a.guard.usage({ inputTokens: 7, outputTokens: 9 })
    for (let i = 0; i < 2100; i++) runtime.note("buffer", "quality", i)
    expect(runtime.snapshot().events).toHaveLength(2000)
    const diagnostic = JSON.stringify(runtime.snapshot())
    expect(diagnostic).not.toContain("PRIVATE")
    expect(diagnostic).not.toContain("api-secret")
    expect(diagnostic).not.toContain(a.lease)
    expect(runtime.snapshot().counters["provider-start"]).toBe(1)
    runtime.setDiagnostics(false)
    expect(runtime.snapshot().events).toEqual([])
  })
  it("revalidates a revoked lease synchronously after reserving but before the SDK dispatch", async () => {
    const runtime = new SubtitleWorkRuntime(),
      a = subscriber(runtime, 1)
    await a.guard.beforeCall("hello", 128)
    runtime.revoke(1, a.lease)
    expect(() => a.guard.onDispatch?.()).toThrow("lease")
    expect(runtime.snapshot().counters["provider-start"] ?? 0).toBe(0)
    expect(fixture.budgets.get("playback").requests).toBe(1)
  })
  it("blocks speculation at the soft limit, permits reserved urgent work, then rejects urgent at hard limit", async () => {
    fixture.limits.requests = 5
    fixture.limits.emergencyPercent = 40
    const runtime = new SubtitleWorkRuntime()
    for (let i = 0; i < 3; i++)
      await subscriber(runtime, i, "quality", false).guard.beforeCall("hello", 128)
    await expect(
      subscriber(runtime, 3, "quality", false).guard.beforeCall("hello", 128),
    ).rejects.toThrow("soft-budget")
    for (const id of [4, 5]) await subscriber(runtime, id).guard.beforeCall("hello", 128)
    await expect(subscriber(runtime, 6).guard.beforeCall("hello", 128)).rejects.toThrow(
      "hard-budget",
    )
    expect(runtime.snapshot().counters["dispatch-authorized"]).toBe(5)
  })

  it("a retried malformed batch plus singleton fallback cannot exceed three attempts per member", async () => {
    fixture.limits.requests = 100
    const runtime = new SubtitleWorkRuntime(),
      { scope } = subscriber(runtime, 1)
    const keys = ["one", "two", "three", "four"]
    const batch = runtime.guard(() => [scope], keys)
    await batch.beforeCall("batch", 128)
    batch.onDispatch?.()
    await batch.beforeCall("malformed retry", 128)
    batch.onDispatch?.()
    for (const key of keys) {
      const single = runtime.guard(() => [scope], [key])
      await single.beforeCall("fallback", 128)
      single.onDispatch?.()
      await expect(single.beforeCall("network retry", 128)).rejects.toThrow("attempts")
    }
    expect(runtime.snapshot().counters["dispatch-authorized"]).toBe(6)
    expect(runtime.snapshot().counters.retry).toBe(5)
  })

  it("two lanes racing for the last credit cause exactly one Provider start", async () => {
    fixture.limits.requests = 1
    const runtime = new SubtitleWorkRuntime()
    const a = subscriber(runtime, 1),
      b = subscriber(runtime, 2, "quality")
    const result = await Promise.allSettled([
      a.guard.beforeCall("hello", 128),
      b.guard.beforeCall("hello", 128),
    ])
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(runtime.snapshot().counters["dispatch-authorized"]).toBe(1)
    expect(fixture.budgets.get("playback").requests).toBe(1)
  })
  it("100 seeks, recreated sessions, refreshes and worker restarts cannot reset consumption", async () => {
    let started = 0
    for (let i = 0; i < 100; i++) {
      const runtime = new SubtitleWorkRuntime()
      const { guard, lease } = subscriber(runtime, i)
      try {
        await guard.beforeCall("hello", 128)
        started++
      } catch {
        /* exhausted */
      }
      runtime.revoke(i, lease)
    }
    expect(started).toBe(3)
    expect(fixture.budgets.get("playback").requests).toBe(3)
  })
  it("revocation before an async dispatch checkpoint prevents all subsequent starts", async () => {
    const runtime = new SubtitleWorkRuntime(),
      a = subscriber(runtime, 1)
    const pending = a.guard.beforeCall("hello", 128)
    runtime.revoke(1, a.lease)
    await expect(pending).rejects.toThrow("lease")
    await expect(a.guard.beforeCall("hello", 128)).rejects.toThrow("lease")
    expect(runtime.snapshot().counters["dispatch-authorized"] ?? 0).toBe(0)
  })
  it("revoking playback preserves the independent export subscriber", async () => {
    const runtime = new SubtitleWorkRuntime(),
      a = subscriber(runtime, 1)
    const lease = runtime.open(1, { requests: 5, estimatedTokens: 10000 })
    runtime.register(1, "1:export", {
      lease,
      lane: "export",
      urgent: false,
      logicalKey: "export",
      start: 0,
      end: 1000,
    })
    runtime.revoke(1, a.lease)
    await runtime.guard(() => [a.scope, "1:export"], ["shared"]).beforeCall("hello", 128)
    expect(runtime.snapshot().counters["dispatch-authorized"]).toBe(1)
    expect(fixture.budgets.has("playback")).toBe(false)
  })
})
