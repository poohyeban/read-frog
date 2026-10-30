import { BATCH_SEPARATOR_LINE_PATTERN } from "@/utils/constants/prompt"
export const queueEvents: Array<{ at: number; phase: string; items: number; text: string }> = []
export async function executeTranslate(
  text: string,
  _language: unknown,
  _provider: unknown,
  _prompt: unknown,
  options: { signal?: AbortSignal } = {},
) {
  const items = text.trim().split(BATCH_SEPARATOR_LINE_PATTERN).length
  const record = (phase: string) =>
    queueEvents.push({ at: performance.now(), phase, items, text: text.slice(0, 24) })
  record("execute")
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      options.signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(done, 20)
    const abort = () => {
      clearTimeout(timer)
      record("cancel")
      reject(new DOMException("Aborted", "AbortError"))
    }
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
  })
  record("complete")
  return text
}
