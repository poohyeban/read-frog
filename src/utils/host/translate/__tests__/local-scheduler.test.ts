import { describe, expect, it, vi } from "vitest"
import { LocalScheduler } from "../local-scheduler"

describe("one local work budget", () => {
  it("shares a budget across 30 viewport tasks and does not serialize network completion", async () => {
    let time = 0
    const now = vi.spyOn(performance, "now").mockImplementation(() => time)
    const slices: number[] = []
    let units = 0
    const scheduler = new LocalScheduler(8, async () => {
      slices.push(units)
      units = 0
    })
    let complete!: () => void
    const network = new Promise<void>((resolve) => {
      complete = resolve
    })
    try {
      const tasks = Array.from({ length: 30 }, () =>
        scheduler.schedule(() => {
          units++
          time += 2
          return network
        }),
      )
      // Wait for local dispatch without completing any of the network promises.
      for (let step = 0; step < 150 && scheduler.pending; step++) await Promise.resolve()
      expect(scheduler.pending).toBe(0)
      expect(slices.length).toBeGreaterThan(0)
      expect(Math.max(...slices, units)).toBeLessThanOrEqual(4)
      complete()
      await Promise.all(tasks)
    } finally {
      now.mockRestore()
    }
  })
  it("serves background scanning before a sustained foreground wave finishes", async () => {
    const scheduler = new LocalScheduler()
    const order: string[] = []
    function* job(name: string, count: number) {
      for (let i = 0; i < count; i++) {
        yield
        order.push(name)
      }
    }
    await Promise.all([
      scheduler.run(job("foreground", 100), { foreground: true }),
      scheduler.run(job("background", 10)),
    ])
    expect(order.indexOf("background")).toBeLessThan(10)
    expect(order.filter((name) => name === "background")).toHaveLength(10)
    expect(order.lastIndexOf("background")).toBeLessThan(order.lastIndexOf("foreground"))
  })
  it("deduplicates queued work, cancels expansion and lets background work progress", async () => {
    const scheduler = new LocalScheduler()
    const calls: string[] = []
    const key = {}
    function* job() {
      for (let i = 0; i < 10; i++) {
        yield
        calls.push("background")
      }
    }
    const a = scheduler.run(job(), { key, current: () => calls.length < 5 })
    const b = scheduler.run(job(), { key })
    const foreground = Array.from({ length: 30 }, () =>
      scheduler.schedule(() => calls.push("foreground")),
    )
    expect(a).toBe(b)
    await Promise.all([a, b, ...foreground])
    expect(calls.filter((c) => c === "background").length).toBeLessThan(10)
    expect(calls.filter((c) => c === "foreground").length).toBe(30)
    expect(scheduler.pending).toBe(0)
  })
})
