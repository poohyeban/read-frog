import type { SubtitleModelGuard } from "./work-policy"
import type { LLMProviderConfig } from "@/types/config/provider"
import type { TranslatePromptResult } from "@/utils/prompts/translate"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"
import { consumeRemoteStream } from "@/utils/providers/remote-executor"
import { attachRequestErrorMeta } from "@/utils/request/retry-policy"
import { SubtitleStreamParser, streamProtocolError } from "./stream-protocol"

export function subtitleStreamPrompt(prompt: TranslatePromptResult): TranslatePromptResult {
  return {
    ...prompt,
    systemPrompt: `${prompt.systemPrompt}\n\nSubtitle stream protocol v1: Input is a JSON array of {id,text} records. Translate only text, preserving every id. Output exactly one JSON object per line with exactly {"v":1,"id":<input id>,"text":<complete translation>}. End each object with a newline. No markdown, commentary, reasoning, or separator lines. Include every member exactly once; never combine, omit or renumber members.`,
  }
}

/** Experimental playback strategy, same physical authority and caller's AttemptContext. */
export async function streamSubtitleBatch(
  provider: LLMProviderConfig,
  prompt: TranslatePromptResult,
  count: number,
  maxOutputTokens: number,
  signal?: AbortSignal,
  guard?: SubtitleModelGuard,
  onMember?: (id: number, text: string) => void,
): Promise<string[]> {
  await guard?.beforeCall(`${prompt.systemPrompt}\n${prompt.prompt}`, maxOutputTokens)
  signal?.throwIfAborted()
  return consumeRemoteStream(
    provider,
    {
      instructions: prompt.systemPrompt,
      prompt: prompt.prompt,
      maxOutputTokens,
      ...buildLocalGenerateTextParams(provider),
    },
    async (stream, activeSignal) => {
      const parser = new SubtitleStreamParser(count)
      let finished = false,
        total = 0
      for await (const unknownPart of stream) {
        activeSignal.throwIfAborted()
        const part = unknownPart as Record<string, any>
        if (part.type === "error") {
          const error =
            part.error instanceof Error ? part.error : new Error("Subtitle stream transport failed")
          // Only an explicit HTTP rejection may use the queue's finite retry policy.
          // A broken/ambiguous stream must not replay, even before its first token.
          if (![429, 503].includes(part.error?.statusCode))
            attachRequestErrorMeta(error, { isRetryable: false })
          throw error
        }
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          const delta = part.text ?? part.delta ?? ""
          if (typeof delta !== "string") throw streamProtocolError("invalid delta")
          total += delta.length
          if (total > 65536) throw streamProtocolError("response limit")
          if (part.type === "text-delta")
            for (const member of parser.push(delta))
              if (member.text) onMember?.(member.id, member.text)
        }
        if (part.type === "finish") {
          finished = true
          await guard?.usage(part.totalUsage ?? part.usage)
          if (!["stop", "length"].includes(part.finishReason))
            throw streamProtocolError("unsupported finish reason")
        }
      }
      activeSignal.throwIfAborted()
      if (!finished) throw streamProtocolError("missing finish")
      // Complete explicit-ID records survive a length finish. Empty positions use
      // BatchQueue's existing per-member fallback, inheriting physical attempts.
      return parser.finish()
    },
    signal,
    guard?.onDispatch,
  )
}
