import { RequestQueue } from "@benchmark/baseline-queue"
import { ExecutionSlots } from "@benchmark/baseline-slots"

export function physical(
  concurrency: number,
  onRetry: () => void,
  tuning = { rate: 8, capacity: 20 },
) {
  const slots = new ExecutionSlots(8)
  const queue = new RequestQueue(
    {
      ...tuning,
      timeoutMs: 120000,
      maxRetries: 2,
      baseRetryDelayMs: 1000,
      maxInFlight: concurrency,
      maxQueued: 256,
      slots,
      onRetry,
    },
    30000,
  )
  return {
    inspect: () => ({ active: slots.inFlight }),
    run<T>(
      key: string,
      _consumer: string,
      priority: number,
      signal: AbortSignal | undefined,
      execute: (signal: AbortSignal) => Promise<T>,
    ) {
      const scope = crypto.randomUUID()
      const abort = () => queue.cancelByScope(scope)
      if (signal?.aborted) return Promise.reject(signal.reason)
      signal?.addEventListener("abort", abort, { once: true })
      return queue
        .enqueue((active) => execute(active!), Date.now(), key, [scope], {
          priority,
          providerKey: "account",
        })
        .finally(() => signal?.removeEventListener("abort", abort))
    },
  }
}
