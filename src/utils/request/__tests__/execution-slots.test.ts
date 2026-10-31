import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ExecutionSlots } from "../execution-slots"
import { RequestQueue } from "../request-queue"

const options = {
  rate: 100,
  capacity: 100,
  timeoutMs: 30_000,
  maxRetries: 2,
  baseRetryDelayMs: 1,
  maxInFlight: 1,
  maxQueued: 4,
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it("cannot preempt an uncooperative remote call; urgent work gets the next physical slot", async () => {
  const slots = new ExecutionSlots(2)
  const queue = new RequestQueue({ ...options, slots }, 30_000)
  const starts: string[] = []
  let finish!: (value: string) => void
  const slow = queue
    .enqueue(
      async () => {
        starts.push("quality")
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      },
      0,
      "slow",
      ["quality"],
      { providerKey: "one", priority: 3 },
    )
    .catch(() => "cancelled")
  const exportTask = queue.enqueue(
    async () => {
      starts.push("export")
      return "export"
    },
    0,
    "export",
    ["export"],
    { providerKey: "one", priority: 3 },
  )
  const urgent = queue.enqueue(
    async () => {
      starts.push("fast")
      return "fast"
    },
    0,
    "fast",
    ["fast"],
    { providerKey: "one", priority: 0 },
  )
  queue.cancelByScope("quality")
  await vi.advanceTimersByTimeAsync(0)
  expect(await slow).toBe("cancelled")
  expect(starts).toEqual(["quality"])
  expect(vi.getTimerCount()).toBe(0)
  expect(slots.inFlight).toBe(1)
  finish("late")
  await vi.advanceTimersByTimeAsync(0)
  await Promise.all([urgent, exportTask])
  expect(starts).toEqual(["quality", "fast", "export"])
  expect(slots.inFlight).toBe(0)
})

it("shares limits and 429 cooldown across webpage and subtitle queues, bounding backlog", async () => {
  const slots = new ExecutionSlots(1)
  const webpage = new RequestQueue({ ...options, slots })
  const subtitles = new RequestQueue({ ...options, slots })
  slots.pause("one", Date.now() + 1000)
  const starts: string[] = []
  const pending = Array.from({ length: 4 }, (_, i) =>
    webpage.enqueue(
      async () => {
        starts.push(`page${i}`)
      },
      0,
      `page${i}`,
      ["page"],
      { providerKey: "one" },
    ),
  )
  await expect(webpage.enqueue(async () => {}, 0, "overflow")).rejects.toThrow("queue-full")
  pending.push(
    subtitles.enqueue(
      async () => {
        starts.push("subtitle")
      },
      0,
      "subtitle",
      ["subtitle"],
      { providerKey: "one" },
    ),
  )
  await vi.advanceTimersByTimeAsync(999)
  expect(starts).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all(pending)
  expect(starts.indexOf("subtitle")).toBeLessThan(4)
  expect(slots.inFlight).toBe(0)
})
