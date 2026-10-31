import { sendMessage } from "@/utils/message"

export const SUBTITLE_TRACE_EVENTS = [
  "playback",
  "seek",
  "buffer",
  "fast-suspend",
  "fast-resume",
  "task-created",
  "task-cancel",
  "ready",
  "selected",
  "cache-restored",
  "stale-result",
  "stop-requested",
  "stopped",
  "stop-failed",
  "segmentation-start",
  "segmentation-complete",
] as const
export interface SubtitleTrace {
  event: (typeof SUBTITLE_TRACE_EVENTS)[number]
  lane?: "fast" | "quality" | "segmentation"
  mediaTimeMs: number
  value?: number
}
export type SubtitleTraceSink = (trace: SubtitleTrace) => void

/** No text, prompts, credentials, URLs or source identities enter the diagnostic transport. */
export function createSubtitleTrace(
  enabled: boolean,
  sessionId: string,
): SubtitleTraceSink | undefined {
  if (!enabled) return undefined
  return (trace) => {
    void sendMessage("recordSubtitleDiagnostics", { ...trace, sessionId }).catch(() => {})
  }
}
