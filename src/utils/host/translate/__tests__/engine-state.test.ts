import { afterEach, expect, it, vi } from "vitest"
import { TranslationActivity } from "../engine-state"

afterEach(() => vi.useRealTimers())
it("lets a UI observe immutable progress with one notification per burst and no private engine state", async () => {
  vi.useFakeTimers()
  const state = new TranslationActivity()
  const listener = vi.fn<() => void>()
  const unsubscribe = state.subscribe(listener)
  expect(state.getSnapshot().phase).toBe("idle")
  state.begin("page")
  const context = state.track("context", "page")
  expect(state.getSnapshot().phase).toBe("preparing-context")
  context()
  for (let i = 0; i < 1000; i++) state.track("request", "page")()
  const snapshot = state.getSnapshot()
  expect(snapshot).toBe(state.getSnapshot())
  expect(snapshot).toMatchObject({
    phase: "settled",
    completedRequests: 1000,
    progressScope: "observed-work",
  })
  expect(Object.isFrozen(snapshot.pending)).toBe(true)
  expect(listener).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(50)
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe()
  state.track("render", "page")()
  expect(vi.getTimerCount()).toBe(0)
})
it("isolates old epochs and independent features, exposes retry guidance and releases pending counts on stop", () => {
  const state = new TranslationActivity()
  state.begin("first")
  const old = state.track("request", "first")
  state.track("request", "independent")()
  state.end("first")
  expect(state.getSnapshot()).toMatchObject({
    phase: "cancelled",
    cancelledTasks: 1,
    pending: { request: 0 },
  })
  state.begin("second")
  old(new Error("Late error"))
  expect(state.getSnapshot().failedTasks).toBe(0)
  state.track("context", "second")({ code: "CONTEXT_UNSTABLE" })
  expect(state.getSnapshot()).toMatchObject({
    phase: "error",
    failedTasks: 1,
    lastIssue: { kind: "unstable-context", retryable: true, retryAfterMs: 1000 },
  })
})
