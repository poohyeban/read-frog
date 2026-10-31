import { describe, expect, it } from "vitest"
import { SubtitleWorkRuntime } from "../subtitle-work"

function subscriber(
  runtime: SubtitleWorkRuntime,
  id: number,
  lane: "fast" | "quality" | "export" = "fast",
) {
  const lease = runtime.open(id)
  const scope = `${id}:${lane}:task`
  runtime.register(id, scope, {
    lease,
    lane,
    urgent: lane === "fast",
    logicalKey: scope,
    start: 0,
    end: 1000,
  })
  return { lease, scope, guard: runtime.guard(() => [scope], [scope]) }
}

describe("boot-local subtitle execution authority", () => {
  it("bounds diagnostics without retaining text or execution credentials", async () => {
    const runtime = new SubtitleWorkRuntime()
    runtime.setDiagnostics(true)
    const a = subscriber(runtime, 1)
    await a.guard.beforeCall("PRIVATE caption with api-secret", 128)
    a.guard.onDispatch?.()
    await a.guard.usage({ inputTokens: 7, outputTokens: 9 })
    for (let i = 0; i < 2100; i++) runtime.note("buffer", "quality", i)
    expect(runtime.snapshot().events).toHaveLength(2000)
    const diagnostic = JSON.stringify(runtime.snapshot())
    for (const secret of ["PRIVATE", "api-secret", a.lease])
      expect(diagnostic).not.toContain(secret)
    expect(runtime.snapshot().counters["provider-start"]).toBe(1)
    expect(runtime.snapshot().counters["usage-input-tokens"]).toBe(7)
    runtime.setDiagnostics(false)
    expect(runtime.snapshot().events).toEqual([])
  })
  it("revalidates a revoked lease after async preparation and before dispatch", async () => {
    const runtime = new SubtitleWorkRuntime()
    const a = subscriber(runtime, 1)
    await a.guard.beforeCall("hello", 128)
    runtime.revoke(1, a.lease)
    expect(() => a.guard.onDispatch?.()).toThrow("lease")
    await expect(a.guard.beforeCall("hello", 128)).rejects.toThrow("lease")
    expect(runtime.snapshot().counters["provider-start"] ?? 0).toBe(0)
  })
  it("100 stop/start cycles and worker replacement cannot resurrect an old lease", async () => {
    const runtime = new SubtitleWorkRuntime()
    for (let i = 0; i < 100; i++) {
      const a = subscriber(runtime, i)
      await a.guard.beforeCall("hello", 128)
      runtime.revoke(i, a.lease)
      expect(() => a.guard.onDispatch?.()).toThrow("lease")
      expect(() =>
        new SubtitleWorkRuntime().register(i, a.scope, {
          lease: a.lease,
          lane: "fast",
          urgent: true,
          logicalKey: a.scope,
          start: 0,
          end: 1000,
        }),
      ).toThrow("lease")
    }
    expect(runtime.snapshot().counters["provider-start"] ?? 0).toBe(0)
  })
  it("revoking playback preserves independent export and remaining shared subscribers", async () => {
    const runtime = new SubtitleWorkRuntime()
    const a = subscriber(runtime, 1)
    const b = subscriber(runtime, 1, "export")
    runtime.revoke(1, a.lease)
    const guard = runtime.guard(() => [a.scope, b.scope], ["shared"])
    await guard.beforeCall("hello", 128)
    guard.onDispatch?.()
    expect(runtime.snapshot().counters["provider-start"]).toBe(1)
    runtime.revoke(1, b.lease)
    await expect(guard.beforeCall("hello", 128)).rejects.toThrow("lease")
  })
  it("does not let a different tab revoke or register another tab's lease", () => {
    const runtime = new SubtitleWorkRuntime(),
      a = subscriber(runtime, 1)
    expect(runtime.revoke(2, a.lease)).toEqual([])
    expect(runtime.hasLease(1, a.lease)).toBe(true)
    expect(() =>
      runtime.register(2, "foreign", {
        lease: a.lease,
        lane: "fast",
        urgent: true,
        logicalKey: "foreign",
        start: 0,
        end: 1000,
      }),
    ).toThrow("lease")
  })
})
