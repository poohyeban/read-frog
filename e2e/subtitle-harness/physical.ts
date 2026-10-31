import { getExecutionContext } from "@/utils/request/execution-context"
import { RequestQueue } from "@/utils/request/request-queue"
import { resolveResourcePolicy } from "@/utils/request/resource-policy"
import { ResourceScheduler } from "@/utils/request/resource-scheduler"
import { getRequestErrorMeta, getRetryAfterMs } from "@/utils/request/retry-policy"

export function physical(
  concurrency: number,
  onRetry: () => void,
  tuning = { rate: 8, capacity: 20 },
) {
  const scheduler = new ResourceScheduler()
  const policy = resolveResourcePolicy({ maxInFlight: concurrency, ...tuning })
  scheduler.configure([{ id: "account", policy }], new Map([["account", ["account"]]]))
  const queue = new RequestQueue({
    consumer: "benchmark",
    timeoutMs: policy.timeoutMs,
    maxRetries: 2,
    baseRetryDelayMs: policy.baseRetryDelayMs,
    maxQueued: 256,
    onRetry,
  })
  return {
    inspect: () => scheduler.inspect(),
    run<T>(
      key: string,
      consumer: string,
      priority: number,
      signal: AbortSignal | undefined,
      execute: (signal: AbortSignal) => Promise<T>,
    ) {
      const scope = crypto.randomUUID()
      const abort = () => queue.cancelByScope(scope)
      if (signal?.aborted) return Promise.reject(signal.reason)
      signal?.addEventListener("abort", abort, { once: true })
      return queue
        .enqueue(
          async (active) => {
            const context = getExecutionContext(active)!
            context.policy ??= policy
            let settle!: () => void
            context.physicalSettled = new Promise((resolve) => {
              settle = resolve
            })
            return scheduler.run(
              {
                resourceId: "account",
                consumer,
                priority,
                signal: active,
                attempts: context.attempts,
                onSettled: settle,
                onAbort: context.abort,
              },
              async (remoteSignal, permit) => {
                permit.start()
                try {
                  return await execute(remoteSignal)
                } catch (error) {
                  const meta = getRequestErrorMeta(error)
                  if (meta.statusCode === 429)
                    permit.cooldown?.(
                      Date.now() + (getRetryAfterMs(meta) ?? policy.cooldownMs),
                      "shared",
                    )
                  throw error
                }
              },
            )
          },
          Date.now(),
          key,
          [scope],
          { priority },
        )
        .finally(() => signal?.removeEventListener("abort", abort))
    },
  }
}
