import { expect, it, vi } from "vitest"
import {
  publishSubtitleStream,
  routeSubtitleStreamFallback,
  subscribeSubtitleStream,
} from "../subtitle-stream-updates"

it("routes a shared singleton only to its missing original occurrences and removes routes on settlement/disconnect", () => {
  const a = vi.fn<(update: unknown) => void>(),
    b = vi.fn<(update: unknown) => void>()
  const offA = subscribeSubtitleStream("tab-a", a),
    offB = subscribeSubtitleStream("tab-b", b)
  const first = routeSubtitleStreamFallback(["tab-a"], "same-prompt", "a-cue-1")
  const second = routeSubtitleStreamFallback(["tab-a"], "same-prompt", "a-cue-2")
  const other = routeSubtitleStreamFallback(["tab-b"], "same-prompt", "b-cue-0")
  const emit = () =>
    publishSubtitleStream(["tab-a", "tab-b"], { hash: "same-prompt", translation: "shared" }, true)
  try {
    emit()
    expect(a.mock.calls.flat()).toEqual([
      { hash: "a-cue-1", translation: "shared" },
      { hash: "a-cue-2", translation: "shared" },
    ])
    expect(b.mock.calls.flat()).toEqual([{ hash: "b-cue-0", translation: "shared" }])
    first()
    first()
    second()
    a.mockClear()
    b.mockClear()
    emit()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    offB()
    b.mockClear()
    emit()
    expect(b).not.toHaveBeenCalled()
    publishSubtitleStream(["tab-a"], { hash: "confirmed-other-member", translation: "batch" })
    expect(a).toHaveBeenCalledWith({ hash: "confirmed-other-member", translation: "batch" })
  } finally {
    first()
    second()
    other()
    offA()
    offB()
  }
})
