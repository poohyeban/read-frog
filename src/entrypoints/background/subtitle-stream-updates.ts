import type { SubtitleStreamUpdate } from "@/utils/subtitles/stream-protocol"
// Only active port subscriptions; no retained results or additional task lifecycle.
const listeners = new Map<
  string,
  {
    receive: (update: SubtitleStreamUpdate) => void
    fallbacks: Map<string, Map<string, number>>
  }
>()
export function subscribeSubtitleStream(
  scope: string,
  listener: (update: SubtitleStreamUpdate) => void,
) {
  if (listeners.size >= 512) throw new Error("Subtitle stream capacity reached")
  if (listeners.has(scope)) throw new Error("Subtitle stream scope already subscribed")
  const entry = { receive: listener, fallbacks: new Map<string, Map<string, number>>() }
  listeners.set(scope, entry)
  return () => {
    if (listeners.get(scope) === entry) listeners.delete(scope)
  }
}

/** One shared singleton prompt can serve different occurrences in each live batch. */
export function routeSubtitleStreamFallback(
  scopes: readonly string[] | undefined,
  key: string,
  hash: string,
) {
  const releases = (scopes ?? []).flatMap((scope) => {
    const entry = listeners.get(scope)
    if (!entry) return []
    const routes = entry.fallbacks.get(key) ?? new Map<string, number>()
    entry.fallbacks.set(key, routes)
    routes.set(hash, (routes.get(hash) ?? 0) + 1)
    return [
      () => {
        const count = routes.get(hash)! - 1
        if (count) routes.set(hash, count)
        else routes.delete(hash)
        if (!routes.size) entry.fallbacks.delete(key)
      },
    ]
  })
  return () => {
    for (const release of releases.splice(0)) release()
  }
}
export function publishSubtitleStream(
  scopes: readonly string[] | undefined,
  update: SubtitleStreamUpdate,
  fallback = false,
) {
  for (const scope of scopes ?? []) {
    const entry = listeners.get(scope)
    if (!entry) continue
    if (fallback) {
      for (const hash of entry.fallbacks.get(update.hash)?.keys() ?? [])
        entry.receive({ hash, translation: update.translation })
    } else entry.receive(update)
  }
}
