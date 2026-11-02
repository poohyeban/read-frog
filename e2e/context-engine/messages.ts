const cache = new Map<string, string>()
const cancelled = new Set<string | undefined>()
export const metrics = { requests: 0, hits: 0, summaryRPCs: 0 }
export function resetMessages() {
  cache.clear()
  cancelled.clear()
  metrics.requests = 0
  metrics.hits = 0
  metrics.summaryRPCs = 0
}
export async function sendMessage(
  name: string,
  data: {
    sessionId?: string
    hash?: string
    webTitle?: string
    webContent?: string
    text?: string
    webSummary?: string
  } = {},
) {
  if (name === "getOrGenerateWebPageSummary") metrics.summaryRPCs++
  if (name === "getGlossarySnapshot") return { revision: 0, scopeKey: "local", entries: [] }
  if (name === "cancelPageTranslationRequests") {
    cancelled.add(data.sessionId)
    return undefined
  }
  if (name !== "enqueueTranslateRequest" && name !== "getOrGenerateWebPageSummary") return undefined
  if (cancelled.has(data.sessionId))
    throw Object.assign(new Error("cancelled"), { name: "TranslationCancelledError" })
  const key = data.hash || JSON.stringify([data.webTitle, data.webContent])
  if (cache.has(key)) {
    metrics.hits++
    return cache.get(key)
  }
  metrics.requests++
  const result = await fetch("/mock", {
    method: "POST",
    body: JSON.stringify({
      name,
      text: data.text,
      summary: data.webSummary,
      context: data.webContent,
    }),
  }).then((response) => response.text())
  cache.set(key, result)
  return result
}
export function onMessage() {
  return () => {}
}
