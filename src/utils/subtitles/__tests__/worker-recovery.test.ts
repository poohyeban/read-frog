import { afterEach, describe, expect, it, vi } from "vitest"
import { SubtitleWorkRuntime } from "@/entrypoints/background/subtitle-work"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { runSubtitleRequest, SubtitleFailures } from "../recovery"
import { SubtitleResultError, subtitleFailure } from "../result"
import { SubtitleSession } from "../session"

const rpc = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: rpc.send }))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe("boot-local lease recovery", () => {
  function setup() {
    let worker = new SubtitleWorkRuntime()
    let opens = 0,
      starts = 0
    rpc.send.mockImplementation(async (type, data) => {
      if (type === "openSubtitleLease") {
        opens++
        return worker.open(7, data.traceId)
      }
      if (type === "revokeSubtitleLease") worker.revoke(7, data.lease)
      return undefined
    })
    const session = new SubtitleSession()
    const begin = async (key: string) => {
      const task = session.begin("playback", key)
      const work = await task.prepareWork!("fast", 0, 1000)
      return {
        task,
        work,
        run: () =>
          runSubtitleRequest(task, work, async (current) => {
            try {
              worker.register(7, task.sessionId, current!)
            } catch (error) {
              throw new SubtitleResultError(subtitleFailure(error) as any)
            }
            starts++
            return "translated"
          }),
      }
    }
    return {
      session,
      begin,
      restart: () => {
        worker = new SubtitleWorkRuntime()
      },
      revoke: (id: string) => worker.revoke(7, id),
      counts: () => ({ opens, starts }),
    }
  }
  it("recovers 32 concurrent same-session requests with one new lease after restart", async () => {
    const env = setup()
    const tasks = await Promise.all(Array.from({ length: 32 }, (_, i) => env.begin(String(i))))
    env.restart()
    expect(await Promise.all(tasks.map((t) => t.run()))).toHaveLength(32)
    expect(env.counts()).toEqual({ opens: 2, starts: 32 })
    tasks.forEach((t) => t.task.complete())
    await env.session.stop()
    env.session.dispose()
  })
  it("does not reopen revoked authority or a stopped epoch, including late restart responses", async () => {
    const env = setup()
    const revoked = await env.begin("revoked")
    env.revoke(revoked.work.lease)
    await expect(revoked.run()).rejects.toThrow("lease")
    expect(env.counts()).toEqual({ opens: 1, starts: 0 })
    await env.session.stop()
    env.restart()
    env.session.start()
    await expect(revoked.run()).rejects.toBeInstanceOf(TranslationCancelledError)
    const current = await env.begin("new")
    await expect(current.run()).resolves.toBe("translated")
    expect(env.counts()).toEqual({ opens: 2, starts: 1 })
    await env.session.stop()
    env.session.dispose()
  })
  it("bounds restart recovery to one replay and never replays an ambiguous transport failure", async () => {
    const env = setup()
    const { task, work } = await env.begin("bounded")
    const send = vi.fn<() => Promise<never>>(async () => {
      throw new SubtitleResultError({
        status: "temporary",
        message: "restart",
        code: "lease-expired",
      })
    })
    await expect(runSubtitleRequest(task, work, send)).rejects.toThrow("restart")
    expect(send).toHaveBeenCalledTimes(2)
    const lost = vi.fn<() => Promise<never>>(async () => {
      throw new Error("message port closed after sending")
    })
    await expect(runSubtitleRequest(task, work, lost)).rejects.toMatchObject({
      outcome: { retryExhausted: true },
    })
    expect(lost).toHaveBeenCalledTimes(1)
    await env.session.stop()
    env.session.dispose()
  })
  it("cleans 100 seek cancellations and 100 stop/start cycles", async () => {
    const env = setup()
    for (let i = 0; i < 100; i++) {
      const stale = await env.begin(`seek-${i}`)
      stale.task.cancel()
      await expect(stale.run()).rejects.toBeInstanceOf(TranslationCancelledError)
      await env.session.stop()
      env.session.start()
      const next = await env.begin(`start-${i}`)
      await next.run()
      next.task.complete()
      expect(env.session.taskCount).toBe(0)
    }
    await env.session.stop()
    env.session.dispose()
    expect(env.counts().starts).toBe(100)
  })
  it("preserves sender isolation after cold start", () => {
    const runtime = new SubtitleWorkRuntime()
    const lease = runtime.open(7)
    expect(() =>
      runtime.register(8, "spoofed", {
        lease,
        lane: "fast",
        urgent: true,
        logicalKey: "cue",
        start: 0,
        end: 1000,
      }),
    ).toThrow("lease")
    expect(runtime.hasLease(7, lease)).toBe(true)
  })
})

it("bounds temporary recovery per member, retaining Retry-After and terminal outcomes", () => {
  vi.useFakeTimers()
  const failures = new SubtitleFailures()
  for (let i = 0; i < 3; i++) {
    failures.record("cue", { status: "temporary", message: "network", retryAfterMs: 5000 })
    expect(failures.blocked("cue")).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(failures.blocked("cue")).toBe(i === 2)
  }
  failures.record("exhausted", { status: "temporary", message: "network", retryExhausted: true })
  failures.record("cancelled", { status: "cancelled", message: "stop" })
  vi.advanceTimersByTime(1000000)
  expect(failures.blocked("exhausted")).toBe(true)
  expect(failures.blocked("cancelled")).toBe(true)
  failures.delete("cue")
  expect(failures.blocked("cue")).toBe(false)
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
