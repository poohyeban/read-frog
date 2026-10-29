import type { StreamPortResponse } from "@/types/background-stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { createPortStreamPromise, STREAM_PORT_DISCONNECTED_MESSAGE } from "../port-streaming"

const requestId = "6c71ddf9-3824-4aa2-ae3e-6b043467cefc"
vi.mock("@/utils/crypto-polyfill", () => ({ getRandomUUID: () => requestId }))

function mockPort() {
  const messages = new Set<(value: StreamPortResponse) => void>()
  const disconnects = new Set<() => void>()
  const port = {
    name: "stream-structured-object",
    disconnect: vi.fn<() => void>(),
    postMessage: vi.fn<(message: unknown) => void>(),
    onMessage: {
      addListener: (listener: (value: StreamPortResponse) => void) => messages.add(listener),
      removeListener: (listener: (value: StreamPortResponse) => void) => messages.delete(listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) => disconnects.add(listener),
      removeListener: (listener: () => void) => disconnects.delete(listener),
    },
  }
  vi.spyOn(browser.runtime, "connect").mockReturnValue(
    port as unknown as ReturnType<typeof browser.runtime.connect>,
  )
  return { port, messages, disconnects }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("stream port diagnostics and cleanup", () => {
  it("reads lastError in onDisconnect, logs no_receiver, and releases listeners/timer", async () => {
    const { messages, disconnects } = mockPort()
    const log = vi.spyOn(console, "error")
    const lastError = vi
      .spyOn(browser.runtime, "lastError", "get")
      .mockReturnValue({ message: "Could not establish connection. Receiving end does not exist." })
    const promise = createPortStreamPromise("stream-structured-object", {})
    const outcome = promise.catch((error: unknown) => error)
    disconnects.forEach((listener) => listener())
    await expect(outcome).resolves.toMatchObject({ message: STREAM_PORT_DISCONNECTED_MESSAGE })
    expect(lastError).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({
      scope: "content",
      requestId,
      phase: "disconnect",
      reason: "no_receiver",
    })
    expect(messages.size + disconnects.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports the background HTTP diagnostic in the page console", async () => {
    const { messages, disconnects } = mockPort()
    const log = vi.spyOn(console, "error")
    const promise = createPortStreamPromise("stream-structured-object", {})
    const outcome = promise.catch((error: unknown) => error)
    messages.forEach((listener) =>
      listener({
        type: "error",
        streamRequestId: requestId,
        error: {
          message: "Provider request failed",
          diagnostic: {
            requestId,
            port: "stream-structured-object",
            phase: "request",
            errorType: "AI_APICallError",
            httpStatus: 400,
            responseFormat: "json_schema",
          },
        },
      }),
    )
    await expect(outcome).resolves.toMatchObject({ message: "Provider request failed" })
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({
      scope: "content",
      httpStatus: 400,
      responseFormat: "json_schema",
    })
    expect(messages.size + disconnects.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports a synchronous send failure and cleans up instead of leaking listeners", async () => {
    const { port, messages, disconnects } = mockPort()
    const log = vi.spyOn(console, "error")
    port.postMessage.mockImplementation(() => {
      throw new Error("Extension context invalidated.")
    })
    await expect(createPortStreamPromise("stream-structured-object", {})).rejects.toThrow(
      STREAM_PORT_DISCONNECTED_MESSAGE,
    )
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({
      phase: "send",
      reason: "context_invalidated",
    })
    expect(messages.size + disconnects.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports a synchronous connect failure but stays silent for pre-aborted requests", async () => {
    mockPort()
    const log = vi.spyOn(console, "error")
    vi.mocked(browser.runtime.connect).mockImplementation(() => {
      throw new Error("Extension context invalidated.")
    })
    await expect(createPortStreamPromise("stream-structured-object", {})).rejects.toThrow(
      STREAM_PORT_DISCONNECTED_MESSAGE,
    )
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({
      phase: "connect",
      reason: "context_invalidated",
    })
    log.mockClear()
    await expect(
      createPortStreamPromise("stream-structured-object", {}, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(log).not.toHaveBeenCalled()
  })

  it("keeps successful completion silent", async () => {
    const { messages, disconnects } = mockPort()
    const log = vi.spyOn(console, "error")
    const promise = createPortStreamPromise("stream-structured-object", {})
    messages.forEach((listener) =>
      listener({ type: "done", streamRequestId: requestId, data: "finished" }),
    )
    await expect(promise).resolves.toBe("finished")
    expect(log).not.toHaveBeenCalled()
    expect(messages.size + disconnects.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps deliberate cancellation silent", async () => {
    const { messages, disconnects } = mockPort()
    const log = vi.spyOn(console, "error")
    const controller = new AbortController()
    const promise = createPortStreamPromise(
      "stream-structured-object",
      {},
      { signal: controller.signal },
    )
    const outcome = promise.catch((error: unknown) => error)
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" })
    expect(log).not.toHaveBeenCalled()
    expect(messages.size + disconnects.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
