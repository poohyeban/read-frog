import { afterEach, expect, it, vi } from "vitest"
import { SubtitleFailures } from "../recovery"
afterEach(() => vi.useRealTimers())
const temporary = { status: "temporary" as const, message: "intake busy", code: "queue-full" }
it("keeps an unspent safe recovery available after the former two-minute expiry", () => {
  const failures = new SubtitleFailures()
  failures.record("cue", temporary, 0)
  expect(failures.blocked("cue", 999)).toBe(true)
  expect(failures.blocked("cue", 1000)).toBe(false)
  expect(failures.blocked("cue", 180000)).toBe(false)
  failures.record("cue", temporary, 180000)
  expect(failures.blocked("cue", 181999)).toBe(true)
  expect(failures.blocked("cue", 182000)).toBe(false)
  failures.record("cue", temporary, 182000)
  expect(failures.blocked("cue", 999999999)).toBe(true)
})
it("honors a long Retry-After without declaring it permanently blocked or replenishing attempts", () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const failures = new SubtitleFailures()
  failures.record("cue", { ...temporary, retryAfterMs: 180000 })
  expect(failures.nextRetryAt()).toBe(180000)
  expect(failures.blocked("cue", 179999)).toBe(true)
  expect(failures.blocked("cue", 180000)).toBe(false)
  failures.record("cue", { ...temporary, retryAfterMs: 180000 }, 180000)
  failures.record("cue", temporary, 360000)
  expect(failures.blocked("cue", 999999999)).toBe(true)
})
it.each([
  { ...temporary, retryExhausted: true },
  { status: "permanent" as const, message: "invalid credentials" },
  { status: "cancelled" as const, message: "stopped" },
])("never replenishes terminal outcomes through elapsed time: $status", (outcome) => {
  const failures = new SubtitleFailures()
  failures.record("cue", outcome, 0)
  expect(failures.blocked("cue", 999999999)).toBe(true)
  failures.clear() // Explicit user retry or a new semantic configuration, not a playback event.
  expect(failures.blocked("cue", 999999999)).toBe(false)
})
it("a validated cached success removes the failed state", () => {
  const failures = new SubtitleFailures()
  failures.record("cue", temporary, 0)
  failures.record("cue", { status: "success" }, 10)
  expect(failures.has("cue")).toBe(false)
  expect(failures.nextRetryAt()).toBe(Infinity)
})
