// Deterministic local Provider double: no network, credentials, or model billing.
export const model = {
  events: [] as { type: string; at: number; start?: number; count?: number }[],
  delay: 40,
  segmentDelay: 60,
  reset() {
    this.events = []
  },
}
async function wait(kind: string, fragments: any[], options?: { signal?: AbortSignal }) {
  model.events.push({
    type: `${kind}:enqueue`,
    at: performance.now(),
    start: fragments[0]?.start,
    count: fragments.length,
  })
  model.events.push({
    type: `${kind}:execute`,
    at: performance.now(),
    start: fragments[0]?.start,
    count: fragments.length,
  })
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
        options?.signal?.removeEventListener("abort", abort)
        resolve()
      },
      kind === "segment" ? model.segmentDelay : model.delay,
    )
    if (options?.signal?.aborted) abort()
    else options?.signal?.addEventListener("abort", abort, { once: true })
  })
  model.events.push({ type: `${kind}:complete`, at: performance.now(), start: fragments[0]?.start })
}
export async function translateSubtitles(
  fragments: any[],
  _context: unknown,
  _config?: unknown,
  options?: { signal?: AbortSignal },
) {
  await wait("translate", fragments, options)
  return fragments.map((f) => ({ ...f, translation: `译文 ${f.text}` }))
}
export async function aiSegmentBlock(
  fragments: any[],
  _provider: unknown,
  options?: { signal?: AbortSignal },
) {
  await wait("segment", fragments, options)
  return fragments.map((f) => ({ ...f }))
}
