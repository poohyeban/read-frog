import type { SubtitleStreamUpdate } from "@/utils/subtitles/stream-protocol"
// Only active port subscriptions; no retained results or additional task lifecycle.
const listeners = new Map<string, (update: SubtitleStreamUpdate) => void>()
export function subscribeSubtitleStream(
  scope: string,
  listener: (update: SubtitleStreamUpdate) => void,
) {
  if (listeners.size >= 512) throw new Error("Subtitle stream capacity reached")
  if (listeners.has(scope)) throw new Error("Subtitle stream scope already subscribed")
  listeners.set(scope, listener)
  return () => {
    if (listeners.get(scope) === listener) listeners.delete(scope)
  }
}
export function publishSubtitleStream(
  scopes: readonly string[] | undefined,
  update: SubtitleStreamUpdate,
) {
  for (const scope of scopes ?? []) listeners.get(scope)?.(update)
}
