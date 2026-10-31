import { physical } from "./physical"
// Deterministic local Provider double: no network, credentials, or model billing.
export const model = {
  events: [] as { type: string; at: number; start?: number; count?: number; lane?: string }[],
  delay: 40,
  usePhysical: false,
  concurrency: 2,
  requestRate: 8,
  burst: 20,
  failure: "" as string,
  attempts: new Map<string, number>(),
  retries: 0,
  active: 0,
  peakActive: 0,
  estimatedTokens: 0,
  resource: null as ReturnType<typeof physical> | null,
  segmentDelay: 60,
  reset() {
    this.events = []
    this.attempts.clear()
    this.retries = 0
    this.active = 0
    this.peakActive = 0
    this.estimatedTokens = 0
    this.resource = this.usePhysical
      ? physical(this.concurrency, () => this.retries++, {
          rate: this.requestRate,
          capacity: this.burst,
        })
      : null
  },
}
async function wait(
  kind: string,
  fragments: any[],
  options?: { signal?: AbortSignal; priority?: number; lane?: string },
) {
  const key = `${kind}:${options?.lane ?? ""}:${fragments.map((c) => `${c.start}:${c.end}:${c.text}`).join("|")}`
  model.events.push({
    type: `${kind}:enqueue`,
    at: performance.now(),
    start: fragments[0]?.start,
    count: fragments.length,
  })
  const execute = async (signal?: AbortSignal) => {
    model.events.push({
      type: `${kind}:execute`,
      at: performance.now(),
      start: fragments[0]?.start,
      count: fragments.length,
      lane: options?.lane,
    })
    model.active++
    model.peakActive = Math.max(model.peakActive, model.active)
    model.estimatedTokens +=
      new TextEncoder().encode(fragments.map((c) => c.text).join(" ")).length + 64
    const attempt = (model.attempts.get(key) ?? 0) + 1
    model.attempts.set(key, attempt)
    try {
      if (model.failure && attempt === 1) {
        if (model.failure === "429")
          throw Object.assign(new Error("429 Mock"), { statusCode: 429, retryAfterMs: 1000 })
        if (model.failure === "timeout")
          throw Object.assign(new Error("408 Mock timeout"), { statusCode: 408 })
        if (model.failure === "401")
          throw Object.assign(new Error("401 Mock auth"), { statusCode: 401, isRetryable: false })
      }
      if (model.delay < 0) return
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          model.events.push({
            type: `${kind}:cancel`,
            at: performance.now(),
            start: fragments[0]?.start,
          })
          reject(new DOMException("Cancelled", "AbortError"))
        }
        const timer = setTimeout(
          () => {
            signal?.removeEventListener("abort", abort)
            resolve()
          },
          kind === "segment" ? model.segmentDelay : model.delay,
        )
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
      })
      model.events.push({
        type: `${kind}:complete`,
        at: performance.now(),
        start: fragments[0]?.start,
      })
    } finally {
      model.active--
    }
  }
  if (model.resource)
    return model.resource.run(
      key,
      options?.lane ?? kind,
      options?.priority ?? 1,
      options?.signal,
      execute,
    )
  return execute(options?.signal)
}

export async function translateSubtitles(
  fragments: any[],
  _context: unknown,
  _config?: unknown,
  options?: { signal?: AbortSignal; priority?: number; lane?: string },
) {
  await wait("translate", fragments, options)
  return fragments.map((f) => ({ ...f, translation: `译文 ${f.text}` }))
}
export async function aiSegmentBlock(
  fragments: any[],
  _provider: unknown,
  options?: { signal?: AbortSignal; priority?: number; lane?: string },
) {
  await wait("segment", fragments, options)
  return fragments.map((f) => ({ ...f }))
}

export const resolveSubtitlesProviderRef = async () => null
export const fetchSubtitlesSummary = async () => null
export const buildSubtitlesSummaryContextHash = () => null

export { cleanFragmentsForAi, isSegmentationAligned } from "@benchmark/source-segmentation"
