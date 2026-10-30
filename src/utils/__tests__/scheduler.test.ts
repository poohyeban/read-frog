import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalScheduler } from "../host/translate/local-scheduler"
import { yieldToMain } from "../scheduler"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("yieldToMain", () => {
  it("prefers scheduler.yield when available", async () => {
    const yieldFn = vi.fn<() => Promise<void>>(() => Promise.resolve())
    vi.stubGlobal("scheduler", { yield: yieldFn })

    await yieldToMain()
    expect(yieldFn).toHaveBeenCalledTimes(1)
  })

  it("falls back to scheduler.postTask", async () => {
    const postTask = vi.fn<
      (callback: () => void, options?: { priority?: string }) => Promise<void>
    >((callback) => {
      callback()
      return Promise.resolve()
    })
    vi.stubGlobal("scheduler", { postTask })

    await yieldToMain()
    expect(postTask).toHaveBeenCalledTimes(1)
    expect(postTask.mock.calls[0]![1]).toEqual({ priority: "user-visible" })
  })

  it("falls back to MessageChannel when no scheduler exists", async () => {
    vi.stubGlobal("scheduler", undefined)
    await expect(yieldToMain()).resolves.toBeUndefined()
  })

  it("falls back to setTimeout when MessageChannel is unavailable", async () => {
    vi.stubGlobal("scheduler", undefined)
    vi.stubGlobal("MessageChannel", undefined)
    await expect(yieldToMain()).resolves.toBeUndefined()
  })
})

describe("LocalScheduler budget", () => {
  it("does not yield while the slice budget remains", async () => {
    const yieldFn = vi.fn<() => Promise<void>>(() => Promise.resolve())
    vi.stubGlobal("scheduler", { yield: yieldFn })

    const scheduler = new LocalScheduler(10_000)
    await scheduler.schedule(() => {})
    expect(yieldFn).not.toHaveBeenCalled()
  })

  it("yields and renews the deadline once the budget is spent", async () => {
    const yieldFn = vi.fn<() => Promise<void>>(() => Promise.resolve())
    vi.stubGlobal("scheduler", { yield: yieldFn })

    let time = 0
    const now = vi.spyOn(performance, "now").mockImplementation(() => time)
    try {
      const scheduler = new LocalScheduler(4)
      await scheduler.run(
        (function* () {
          for (let i = 0; i < 3; i++) {
            time += 2
            yield
          }
        })(),
      )
      expect(yieldFn).toHaveBeenCalledTimes(1)
      expect(time).toBe(6)
    } finally {
      now.mockRestore()
    }
  })
})
