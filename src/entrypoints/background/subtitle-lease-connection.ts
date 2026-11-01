import type { Browser } from "#imports"
import { subtitleFailure } from "@/utils/subtitles/result"

/** Lease is created inside the owning connection: there is no open/bind orphan window. */
export function attachSubtitleLeaseConnection(
  port: Browser.runtime.Port,
  open: (trace: string) => string,
  revoke: (lease: string) => void,
) {
  let lease: string | undefined,
    closed = false,
    started = false
  const close = () => {
    if (closed) return
    closed = true
    port.onMessage.removeListener(message)
    port.onDisconnect.removeListener(close)
    if (lease) revoke(lease)
  }
  const message = (wire: { traceId?: string }) => {
    if (started || closed) return
    started = true
    try {
      if (typeof wire?.traceId !== "string" || wire.traceId.length > 128)
        throw new Error("Invalid subtitle lease request")
      lease = open(wire.traceId)
      port.postMessage({ lease })
    } catch (error) {
      try {
        port.postMessage({ outcome: subtitleFailure(error) })
      } catch {
        /* disconnected */
      }
      close()
      try {
        port.disconnect()
      } catch {
        /* disconnected */
      }
    }
  }
  port.onMessage.addListener(message)
  port.onDisconnect.addListener(close)
}
