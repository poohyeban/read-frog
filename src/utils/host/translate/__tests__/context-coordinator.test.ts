import { describe, expect, it, vi } from "vitest"
import { ContextCoordinator } from "../context-coordinator"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  return {
    promise: new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    }),
    resolve: (v: T) => resolve(v),
    reject: (e: unknown) => reject(e),
  }
}

describe("shared context lifecycle", () => {
  it("shares 30 in-flight consumers and reuses ready results", async () => {
    const coordinator = new ContextCoordinator<string>()
    const pending = deferred<string>()
    const load = vi.fn<() => Promise<string>>(() => pending.promise)
    const consumers = Array.from({ length: 30 }, () => coordinator.get("a", load))
    expect(coordinator.state("a")).toBe("pending")
    pending.resolve("article")
    expect(await Promise.all(consumers)).toEqual(Array(30).fill("article"))
    expect(await coordinator.get("a", load)).toBe("article")
    expect(load).toHaveBeenCalledTimes(1)
  })
  it("cancels one subscriber without aborting another; last subscriber aborts underlying work", async () => {
    const coordinator = new ContextCoordinator<string>()
    const first = new AbortController()
    const last = new AbortController()
    let signal!: AbortSignal
    const load = (taskSignal: AbortSignal) => {
      signal = taskSignal
      return new Promise<string>(() => {})
    }
    const a = coordinator.get("a", load, first.signal).catch((error) => error)
    const b = coordinator.get("a", load, last.signal).catch((error) => error)
    await Promise.resolve()
    first.abort()
    expect((await a).name).toBe("TranslationCancelledError")
    expect(signal.aborted).toBe(false)
    last.abort()
    expect((await b).name).toBe("TranslationCancelledError")
    expect(signal.aborted).toBe(true)
    expect(coordinator.size).toBe(0)
  })
  it("does not let a superseded pending result overwrite a new result", async () => {
    const coordinator = new ContextCoordinator<string>()
    const pending = deferred<string>()
    const old = coordinator.get("a", () => pending.promise).catch((error) => error)
    await Promise.resolve()
    coordinator.clear()
    await coordinator.get("a", async () => "new")
    pending.resolve("old")
    expect((await old).name).toBe("TranslationCancelledError")
    expect(await coordinator.get("a", async () => "unexpected")).toBe("new")
  })
  it("cools down failures temporarily and bounds ready results", async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new ContextCoordinator<number>(2, 100)
      const load = vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(1)
      await expect(coordinator.get("a", load)).rejects.toThrow("offline")
      await expect(coordinator.get("a", load)).rejects.toThrow("offline")
      expect(load).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(101)
      expect(await coordinator.get("a", load)).toBe(1)
      await coordinator.get("b", async () => 2)
      await coordinator.get("c", async () => 3)
      expect(coordinator.size).toBe(2)
      expect(coordinator.state("a")).toBe("idle")
    } finally {
      vi.useRealTimers()
    }
  })
})
