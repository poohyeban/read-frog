import { describe, expect, it, vi } from "vitest"
import { RequestQueue } from "@/utils/request/request-queue"
const rpc = vi.hoisted(() => ({ cancel: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: rpc.cancel }))
import { SubtitleSession } from "../session"

describe("SubtitleSession and existing RequestQueue cancellation", () => {
  it("aborts actual queued work only after the last playback/export subscriber leaves", async () => {
    const queue = new RequestQueue({
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
    void playback.stop()
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

describe("worker lease failure reproduction", () => {
  it("does not cache a rejected lease acquisition forever", async () => {
    let opens = 0
    rpc.cancel.mockImplementation(async (type) => {
      if (type === "openSubtitleLease") {
        if (++opens === 1) throw new Error("worker unavailable")
        return "recovered"
      }
      return undefined
    })
    const session = new SubtitleSession()
    const first = session.begin("playback", "first")
    await expect(first.prepareWork!("fast", 0, 1000)).rejects.toThrow("worker unavailable")
    first.complete()
    const next = session.begin("playback", "next")
    await expect(next.prepareWork!("fast", 1000, 2000)).resolves.toMatchObject({
      lease: "recovered",
    })
    await session.stop()
    session.dispose()
  })
  it("retries failed revocation without poisoning every later stop", async () => {
    let revokes = 0
    rpc.cancel.mockImplementation(async (type) => {
      if (type === "openSubtitleLease") return "lease"
      if (type === "revokeSubtitleLease" && ++revokes === 1) throw new Error("worker unavailable")
      return undefined
    })
    const session = new SubtitleSession()
    await session.begin("playback", "first").prepareWork!("fast", 0, 1000)
    await expect(session.stop()).rejects.toThrow("worker unavailable")
    await expect(session.stop()).resolves.toBeUndefined()
    expect(revokes).toBe(2)
    session.dispose()
  })
})

it("does not emit a second control IPC when a cancelled task settles late", () => {
  rpc.cancel.mockReset().mockResolvedValue(undefined)
  const session = new SubtitleSession()
  const task = session.begin("playback", "late")
  task.cancel()
  task.complete()
  task.complete()
  expect(rpc.cancel.mock.calls.map((call) => call[0])).toEqual(["cancelSubtitleRequests"])
  session.dispose()
})

// This suite simulates message RPC; passive port lifecycle is covered by lease-connection and HTTP stream tests.
vi.mock("@/utils/subtitles/lease-connection", async () => {
  const { sendMessage } = await import("@/utils/message")
  return {
    SUBTITLE_LEASE_PORT: "subtitle-lease-v1",
    openSubtitleLeaseConnection: (traceId: string) => ({
      lease: sendMessage("openSubtitleLease", { traceId }),
      close: () => {},
    }),
  }
})
