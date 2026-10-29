import type {
  StreamPortErrorPayload,
  StreamPortRequestMessage,
  StreamPortResponse,
  StreamPortStartMessage,
} from "@/types/background-stream"
import type { ErrorAction } from "@/utils/error-action"
import { browser } from "#imports"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { createStreamDiagnostic, reportStreamDiagnostic } from "@/utils/error/stream-diagnostics"

/**
 * Rejection message when the background port drops mid-stream (service worker
 * restart, extension reload). Callers can match it to treat the failure as an
 * infrastructure hiccup rather than a provider error.
 */
export const STREAM_PORT_DISCONNECTED_MESSAGE = "Stream disconnected unexpectedly"

/**
 * A failure the background reported over the port, with the call to action it
 * attached, if any. A class rather than a duck-typed `action` field so a UI
 * only ever renders buttons the extension itself built — never a URL that
 * happened to sit on some provider's error object.
 */
export class StreamPortError extends Error {
  readonly action?: ErrorAction

  constructor({ message, action }: StreamPortErrorPayload) {
    super(message)
    this.name = "StreamPortError"
    this.action = action
  }
}

/**
 * Handles cleanup, abort signals, and disconnection automatically
 */
export function createPortStreamPromise<TResponse = string>(
  portName: string,
  serializablePayload: unknown,
  options: {
    signal?: AbortSignal
    onChunk?: (data: TResponse) => void
    keepAliveIntervalMs?: number
  } = {},
): Promise<TResponse> {
  return new Promise<TResponse>((resolve, reject) => {
    const { signal, onChunk, keepAliveIntervalMs = 20_000 } = options

    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"))
      return
    }

    const streamRequestId = getRandomUUID()
    const diagnose = (error: unknown, phase: "connect" | "send" | "disconnect" | "request") => {
      reportStreamDiagnostic(
        createStreamDiagnostic(error, {
          requestId: streamRequestId,
          port: portName,
          phase,
        }),
        "content",
      )
    }
    let port: ReturnType<typeof browser.runtime.connect>
    try {
      port = browser.runtime.connect({ name: portName })
    } catch (error) {
      diagnose(error, "connect")
      reject(new Error(STREAM_PORT_DISCONNECTED_MESSAGE))
      return
    }

    let settled = false
    let messageListener: ((event: StreamPortResponse<TResponse>) => void) | undefined
    let disconnectListener: (() => void) | undefined
    let abortListener: (() => void) | undefined
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined

    const cleanup = () => {
      if (messageListener) {
        port.onMessage.removeListener(messageListener)
      }
      if (disconnectListener) {
        port.onDisconnect.removeListener(disconnectListener)
      }
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener)
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
        keepAliveTimer = undefined
      }
    }

    const finalize = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()

      try {
        port.disconnect()
      } catch {
        // The port may already be closed due to a race with onDisconnect.
        // This is expected during cleanup and safe to ignore.
      }

      callback()
    }

    messageListener = (event: StreamPortResponse<TResponse>) => {
      if (settled || !event || event.streamRequestId !== streamRequestId) {
        return
      }

      if (event.type === "chunk") {
        onChunk?.(event.data)
        return
      }

      if (event.type === "done") {
        finalize(() => resolve(event.data))
        return
      }

      if (event.type === "error") {
        if (event.error.diagnostic) {
          reportStreamDiagnostic(event.error.diagnostic, "content")
        } else {
          diagnose(event.error, "request")
        }
        finalize(() => reject(new StreamPortError(event.error)))
      }
    }

    disconnectListener = () => {
      // Chrome exposes lastError only during this callback. Reading it also
      // prevents the unhelpful "Unchecked runtime.lastError" console warning.
      const lastError = browser.runtime.lastError
      if (settled) return
      diagnose(lastError ?? new Error(STREAM_PORT_DISCONNECTED_MESSAGE), "disconnect")
      finalize(() => reject(new Error(STREAM_PORT_DISCONNECTED_MESSAGE)))
    }

    abortListener = () => {
      finalize(() => reject(new DOMException("aborted", "AbortError")))
    }

    port.onMessage.addListener(messageListener)
    port.onDisconnect.addListener(disconnectListener)

    if (signal) {
      signal.addEventListener("abort", abortListener)
    }

    const startMessage: StreamPortStartMessage<unknown> = {
      type: "start",
      streamRequestId,
      payload: serializablePayload,
    }

    try {
      port.postMessage(startMessage)
    } catch (error) {
      diagnose(error, "send")
      finalize(() => reject(new Error(STREAM_PORT_DISCONNECTED_MESSAGE)))
      return
    }

    if (!settled && keepAliveIntervalMs > 0) {
      keepAliveTimer = setInterval(() => {
        if (settled) {
          return
        }

        try {
          const pingMessage: StreamPortRequestMessage<unknown> = {
            type: "ping",
            streamRequestId,
          }
          port.postMessage(pingMessage)
        } catch {
          // Ignore keepalive send failures; disconnect listener will handle it.
        }
      }, keepAliveIntervalMs)
    }
  })
}
