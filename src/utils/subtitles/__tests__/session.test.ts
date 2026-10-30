import { describe, expect, it, vi } from "vitest"
import { RequestQueue } from "@/utils/request/request-queue"
const rpc = vi.hoisted(() => ({ cancel: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: rpc.cancel }))
import { SubtitleSession } from "../session"

describe("SubtitleSession and existing RequestQueue cancellation", () => {
  it("aborts actual queued work only after the last playback/export subscriber leaves", async () => {
    const queue = new RequestQueue({
      rate: 10,
      capacity: 2,
      timeoutMs: 1000,
      maxRetries: 0,
      baseRetryDelayMs: 1,
    })
    rpc.cancel.mockImplementation(async (_type, { sessionId }) => {
      queue.cancelByScope(`7:${sessionId}`)
    })
    const playback = new SubtitleSession({ videoId: "A", trackId: "en", revision: 1 })
    const exporting = new SubtitleSession({ videoId: "A", trackId: "en", revision: 1 })
    const a = playback.begin("playback", "cue")
    const b = exporting.begin("export", "cue")
    let remoteSignal: AbortSignal | undefined
    const work = queue.enqueue(
      (signal) => {
        remoteSignal = signal
        return new Promise<string>(() => {})
      },
      Date.now(),
      "same-plan",
      [`7:${a.sessionId}`],
    )
    const shared = queue.enqueue(async () => "must not execute twice", Date.now(), "same-plan", [
      `7:${b.sessionId}`,
    ])
    const settled = Promise.allSettled([work, shared])
    playback.stop()
    expect(a.isCurrent()).toBe(false)
    expect(remoteSignal?.aborted).toBe(false)
    expect(b.isCurrent()).toBe(true)
    exporting.dispose()
    expect(remoteSignal?.aborted).toBe(true)
    expect((await settled).every((r) => r.status === "rejected")).toBe(true)
    expect(playback.taskCount).toBe(0)
    playback.start()
    const next = playback.begin("playback", "cue")
    expect(next.sessionId).not.toBe(a.sessionId)
    expect(next.isCurrent()).toBe(true)
    a.complete()
    expect(next.isCurrent()).toBe(true)
    playback.dispose()
  })
  it("keeps segmentation and summary cancellations separate", () => {
    rpc.cancel.mockResolvedValue(undefined)
    const session = new SubtitleSession()
    const segment = session.begin("segmentation", "chunk")
    const summary = session.begin("context", "summary")
    session.cancel("segmentation")
    expect(segment.signal.aborted).toBe(true)
    expect(summary.signal.aborted).toBe(false)
    summary.complete()
    expect(session.taskCount).toBe(0)
    session.dispose()
    expect(() => session.start()).toThrow(/cancelled/)
  })
})
