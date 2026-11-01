import { browser } from "#imports"
import { SubtitleResultError, type SubtitleOutcome } from "./result"

export const SUBTITLE_LEASE_PORT = "subtitle-lease-v1"
/** Passive ownership, no heartbeat or reconnect. Opening a port alone does not keep MV3 alive. */
export function openSubtitleLeaseConnection(traceId: string, onDisconnect: () => void) {
  const port = browser.runtime.connect({ name: SUBTITLE_LEASE_PORT })
  let settled = false,
    closed = false
  let rejectLease!: (error: unknown) => void
  const close = () => {
    if (closed) return
    closed = true
    port.onMessage.removeListener(message)
    port.onDisconnect.removeListener(disconnected)
    if (!settled) rejectLease(new Error("Subtitle lease connection closed before admission"))
    try {
      port.disconnect()
    } catch {
      /* Worker already gone */
    }
    onDisconnect()
  }
  const disconnected = () => close()
  let resolveLease!: (lease: string) => void
  const message = (wire: { lease?: string; outcome?: SubtitleOutcome }) => {
    if (closed || settled) return
    if (typeof wire?.lease === "string") {
      settled = true
      resolveLease(wire.lease)
    } else if (
      wire?.outcome &&
      wire.outcome.status !== "success" &&
      wire.outcome.status !== "empty"
    ) {
      settled = true
      rejectLease(new SubtitleResultError(wire.outcome))
      close()
    }
  }
  const lease = new Promise<string>((resolve, reject) => {
    resolveLease = resolve
    rejectLease = reject
  })
  port.onMessage.addListener(message)
  port.onDisconnect.addListener(disconnected)
  try {
    port.postMessage({ traceId })
  } catch (error) {
    rejectLease(error)
    close()
  }
  return { lease, close }
}
