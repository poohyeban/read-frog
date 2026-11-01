import type { SubtitleBatchRequestPayload } from "@/types/subtitle-request"
import type { sendMessage } from "@/utils/message"
import { browser } from "#imports"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import {
  SUBTITLE_STREAM_PORT,
  streamProtocolError,
  type SubtitleStreamUpdate,
} from "./stream-protocol"

type BatchResponse = Awaited<ReturnType<typeof sendMessage<"enqueueSubtitlesTranslateBatch">>>
/** One port per subscribed batch. No heartbeat, Worker keepalive or reconnect/replay. */
export function requestSubtitleStream(
  payload: SubtitleBatchRequestPayload,
  signal?: AbortSignal,
  onMember?: (member: SubtitleStreamUpdate) => void,
): Promise<BatchResponse> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connect({ name: SUBTITLE_STREAM_PORT })
    const streamRequestId = getRandomUUID()
    let settled = false
    const finish = (error?: unknown, result?: BatchResponse) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      port.onMessage.removeListener(message)
      port.onDisconnect.removeListener(disconnected)
      try {
        port.disconnect()
      } catch {
        /* already disconnected */
      }
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(signal?.reason ?? new DOMException("Cancelled", "AbortError"))
    const disconnected = () =>
      finish(streamProtocolError("port disconnected; request may have been sent"))
    const message = (wire: any) => {
      if (settled || signal?.aborted || wire?.streamRequestId !== streamRequestId) return
      if (wire.type === "chunk" && wire.data?.member) onMember?.(wire.data.member)
      else if (wire.type === "done" && wire.data?.result) finish(undefined, wire.data.result)
      else if (wire.type === "error")
        finish(streamProtocolError(wire.error?.message ?? "transport failed"))
    }
    port.onMessage.addListener(message)
    port.onDisconnect.addListener(disconnected)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      port.postMessage({ type: "start", streamRequestId, payload })
    } catch (error) {
      finish(error)
    }
  })
}
