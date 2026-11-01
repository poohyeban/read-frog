import { afterEach, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { attachSubtitleLeaseConnection } from "@/entrypoints/background/subtitle-lease-connection"
import { SubtitleWorkRuntime } from "@/entrypoints/background/subtitle-work"
import { SubtitleSession } from "../session"
const rpc = vi.hoisted(() => ({ send: vi.fn<(...args: any[]) => any>() }))
vi.mock("@/utils/message", () => ({ sendMessage: rpc.send }))
function event() {
  const listeners = new Set<(value?: any) => void>()
  return {
    addListener: (fn: (value?: any) => void) => listeners.add(fn),
    removeListener: (fn: (value?: any) => void) => listeners.delete(fn),
    emit: (value?: any) => {
      for (const fn of [...listeners]) fn(value)
    },
    listeners,
  }
}
function setup(answer = true) {
  const runtime = new SubtitleWorkRuntime(),
    all: any[] = []
  vi.spyOn(browser.runtime, "connect").mockImplementation((() => {
    let closed = false
    const client = {
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (value: any) => queueMicrotask(() => server.onMessage.emit(value)),
      disconnect: () => disconnect(),
    }
    const server = {
      ...client,
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (value: any) => queueMicrotask(() => client.onMessage.emit(value)),
    }
    function disconnect() {
      if (closed) return
      closed = true
      queueMicrotask(() => {
        client.onDisconnect.emit()
        server.onDisconnect.emit()
      })
    }
    if (answer)
      attachSubtitleLeaseConnection(
        server as any,
        (trace) => runtime.open(7, trace),
        (lease) => runtime.revoke(7, lease),
      )
    all.push(client, server)
    return client
  }) as any)
  rpc.send.mockResolvedValue(undefined)
  return { runtime, all }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it("reclaims 500 sessions even when Stop RPCs fail; old leases cannot authorize work", async () => {
  const { runtime, all } = setup()
  rpc.send.mockImplementation(async (name) => {
    if (name === "revokeSubtitleLease") throw new Error("RPC lost")
  })
  for (let i = 0; i < 500; i++) {
    const session = new SubtitleSession()
    const task = session.begin("playback", `cue-${i}`)
    const work = await task.prepareWork!("fast", 0, 1000)
    runtime.register(7, task.sessionId, work)
    expect(runtime.leaseCount).toBe(1)
    await session.stop().catch(() => {})
    expect(runtime.leaseCount).toBe(0)
    expect(() => runtime.register(7, task.sessionId, work)).toThrow("lease")
    session.dispose()
  }
  expect(
    all.every((p) => p.onMessage.listeners.size === 0 && p.onDisconnect.listeners.size === 0),
  ).toBe(true)
})
it("bounds revocation RPCs and retained authority across 500 failed Stop/Start cycles of ONE session", async () => {
  const { runtime, all } = setup()
  rpc.send.mockClear().mockImplementation(async (name) => {
    if (name === "revokeSubtitleLease") throw new Error("RPC lost")
  })
  const session = new SubtitleSession()
  for (let i = 0; i < 500; i++) {
    session.start()
    const task = session.begin("playback", `cue-${i}`)
    const work = await task.prepareWork!("fast", i * 1000, i * 1000 + 900)
    runtime.register(7, task.sessionId, work)
    const stopped = session.stop()
    await expect(stopped).rejects.toThrow("RPC lost")
    expect(session.taskCount).toBe(0)
    expect(task.signal.aborted).toBe(true)
    expect(runtime.leaseCount).toBe(0)
    expect(() => runtime.register(7, task.sessionId, work)).toThrow("lease")
  }
  const revokes = rpc.send.mock.calls.filter(([name]) => name === "revokeSubtitleLease")
  // Each closed connection already revoked its lease. Failed acknowledgements
  // must not become an unbounded retry backlog on this long-lived Session.
  expect.soft(revokes).toHaveLength(500)
  expect.soft(new Set(revokes.map(([, data]) => data.lease)).size).toBe(500)
  expect.soft((session as any).revocations?.size ?? 0).toBe(0)
  await session.stop().catch(() => {})
  session.dispose()
  await Promise.resolve()
  expect(rpc.send.mock.calls.filter(([name]) => name === "revokeSubtitleLease")).toHaveLength(500)
  expect(
    all.every((p) => p.onMessage.listeners.size === 0 && p.onDisconnect.listeners.size === 0),
  ).toBe(true)
})
it("keeps a long-paused live session and independent export authorized until their own connection closes", async () => {
  const { runtime, all } = setup()
  vi.useFakeTimers()
  const a = new SubtitleSession(),
    b = new SubtitleSession()
  const task = a.begin("playback", "a"),
    exportTask = b.begin("export", "b")
  const work = await task.prepareWork!("fast", 0, 1000),
    exported = await exportTask.prepareWork!("export", 0, 1000)
  vi.setSystemTime(Date.now() + 8 * 3600000)
  expect(runtime.hasLease(7, work.lease)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  all[0].disconnect() // abnormal document/port loss, no Stop RPC
  await Promise.resolve()
  expect(runtime.hasLease(7, work.lease)).toBe(false)
  expect(runtime.hasLease(7, exported.lease)).toBe(true)
  expect(a.taskCount).toBe(1) // no blind replay or new task allocation
  expect(all).toHaveLength(4)
  await a.stop()
  await b.stop()
  a.dispose()
  b.dispose()
})
it("Stop terminates an unanswered lease handshake instead of waiting forever", async () => {
  const { runtime, all } = setup(false)
  const session = new SubtitleSession(),
    task = session.begin("playback", "pending")
  const pending = task.prepareWork!("fast", 0, 1000).catch((error) => error)
  await session.stop()
  expect(await pending).toBeInstanceOf(Error)
  expect(runtime.leaseCount).toBe(0)
  expect(
    all.every((p) => p.onMessage.listeners.size === 0 && p.onDisconnect.listeners.size === 0),
  ).toBe(true)
  session.dispose()
})
