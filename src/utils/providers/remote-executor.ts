import type { LLMProviderConfig } from "@/types/config/provider"
import { generateText, streamText } from "ai"
import { attachRequestErrorMeta, getRequestErrorMeta } from "@/utils/request/retry-policy"
import { getLanguageModelForConfig } from "./model"
import { runProviderOperation } from "./resource-runtime"

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type GenerateParams = DistributiveOmit<
  Parameters<typeof generateText>[0],
  "model" | "abortSignal" | "maxRetries"
>
type StreamParams = DistributiveOmit<
  Parameters<typeof streamText>[0],
  "model" | "abortSignal" | "maxRetries"
>

export function generateRemoteText(
  provider: LLMProviderConfig,
  params: GenerateParams,
  signal?: AbortSignal,
  beforeSend?: () => void,
) {
  return runProviderOperation(
    provider,
    signal,
    (abortSignal, permit) =>
      generateText({
        ...params,
        model: getLanguageModelForConfig(provider, permit),
        abortSignal,
        maxRetries: 0,
      }),
    beforeSend,
  )
}

/** Keep the physical permit through consumption, including interrupted stream cleanup. */
export function consumeRemoteStream<T>(
  provider: LLMProviderConfig,
  params: StreamParams,
  consume: (stream: AsyncIterable<unknown>, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  beforeSend?: () => void,
): Promise<T> {
  return runProviderOperation(
    provider,
    signal,
    async (abortSignal, permit) => {
      let started = false
      const result = streamText({
        ...params,
        model: getLanguageModelForConfig(provider, {
          ...permit,
          start: () => {
            permit.start()
            started = true
          },
        }),
        abortSignal,
        maxRetries: 0,
      })
      // Reading the SDK iterator to completion confirms client termination. Its
      // return() also cancels the underlying reader when consumption throws.
      let emitted = false
      const iterator = result.stream[Symbol.asyncIterator]()
      async function* observed() {
        for (;;) {
          const next = await iterator.next()
          if (next.done) return
          const part = next.value
          if (part.type === "text-delta" || part.type === "reasoning-delta") emitted = true
          yield part
        }
      }
      try {
        return await consume(observed(), abortSignal)
      } catch (error) {
        // No delta does not prove that the server never received the request.
        // Both yielded SDK errors and iterator rejections obey this boundary.
        const explicitRejection = [429, 503].includes(getRequestErrorMeta(error).statusCode ?? 0)
        if (emitted || (started && !explicitRejection)) {
          const failure =
            error instanceof Error ? error : new Error("Stream transport failed", { cause: error })
          throw attachRequestErrorMeta(failure, { isRetryable: false })
        }
        throw error
      } finally {
        // Also handles a consumer that returns before reading its first chunk.
        await iterator.return?.()
      }
    },
    beforeSend,
  )
}
