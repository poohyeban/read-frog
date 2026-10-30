interface SchedulerLike {
  yield?: () => Promise<void>
  postTask?: (callback: () => void, options?: { priority?: string }) => Promise<void>
}

/**
 * Yield to the event loop so input and rendering can run between work slices.
 * MV3 content scripts share the page's main thread, so long synchronous DOM
 * work freezes the page (#1881). Preference order: scheduler.yield (Chrome
 * 129+) → scheduler.postTask (Chrome 94+ / Firefox 101+) → MessageChannel
 * (everywhere; unlike setTimeout it dodges the nested-timer 4ms clamp) →
 * setTimeout(0).
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield()
  }
  if (typeof scheduler?.postTask === "function") {
    return scheduler.postTask(() => {}, { priority: "user-visible" })
  }
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = () => {
        port1.close()
        port2.close()
        resolve()
      }
      port2.postMessage(null)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}
