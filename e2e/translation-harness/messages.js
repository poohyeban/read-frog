const translations = new Map()
const summaries = new Map()
const cancelled = new Set()
const delay = () => new Promise((resolve) => setTimeout(resolve, 80))
export const metrics = { summaries: 0, summaryMessages: 0, translations: 0, cacheHits: 0 }
export async function sendMessage(name, data) {
  if (name === "getGlossarySnapshot") return { revision: 0, scopeKey: "fixture", entries: [] }
  if (name === "cancelPageTranslationRequests") {
    cancelled.add(data.sessionId)
    return undefined
  }
  if (name === "getOrGenerateWebPageSummary") {
    metrics.summaryMessages++
    const key = JSON.stringify([data.providerRef, data.webTitle, data.webContent])
    if (!summaries.has(key))
      summaries.set(
        key,
        (async () => {
          metrics.summaries++
          await delay()
          return "Researchers study seasonal changes in tree frog habitats."
        })(),
      )
    return summaries.get(key)
  }
  if (name === "enqueueTranslateRequest") {
    if (cancelled.has(data.sessionId)) {
      const error = new Error("cancelled")
      error.name = "TranslationCancelledError"
      throw error
    }
    if (translations.has(data.hash)) {
      metrics.cacheHits++
      return translations.get(data.hash)
    }
    metrics.translations++
    await delay()
    const result = "这是完整的本地模拟译文，用于验证翻译和布局。"
    translations.set(data.hash, result)
    return result
  }
  return undefined
}
export function onMessage() {
  return () => {}
}
