import type { SubtitleBatchRequestPayload } from "@/types/subtitle-request"
import { isLLMProviderConfig } from "@/types/config/provider"
import {
  BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS,
  DEFAULT_TRANSLATE_PROMPT_ID,
} from "@/utils/constants/prompt"
import { attachRequestErrorMeta } from "@/utils/request/retry-policy"

export const SUBTITLE_STREAM_PORT = "subtitle-batch-stream-v1"
export type SubtitleStreamMember = { id: number; text: string }
export type SubtitleStreamUpdate = { hash: string; translation: string }
export function streamProtocolError(message: string): Error {
  return attachRequestErrorMeta(new Error(`Subtitle stream: ${message}`), { isRetryable: false })
}

/** Versioned NDJSON, explicit member IDs: a missing line never shifts cue alignment. */
export class SubtitleStreamParser {
  private buffer = ""
  private size = 0
  private members = new Map<number, string>()
  constructor(private count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 32)
      throw streamProtocolError("member limit")
  }
  push(delta: string): SubtitleStreamMember[] {
    this.size += delta.length
    if (this.size > 65536) throw streamProtocolError("response limit")
    this.buffer += delta
    const parsed: SubtitleStreamMember[] = []
    let boundary: number
    while ((boundary = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 1)
      parsed.push(this.line(line))
    }
    if (this.buffer.length > 8192) throw streamProtocolError("line limit")
    return parsed
  }
  private line(line: string): SubtitleStreamMember {
    if (line.length > 8192) throw streamProtocolError("line limit")
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      throw streamProtocolError("invalid JSON line")
    }
    if (!row || typeof row !== "object") throw streamProtocolError("invalid member")
    const { v, id, text } = row as Record<string, unknown>
    if (
      Object.keys(row).sort().join() !== "id,text,v" ||
      v !== 1 ||
      !Number.isInteger(id) ||
      typeof id !== "number" ||
      id < 0 ||
      id >= this.count ||
      typeof text !== "string" ||
      /<\/?think\b/i.test(text) ||
      /^\s*%%\s*$/m.test(text)
    )
      throw streamProtocolError("invalid member")
    if (this.members.has(id)) throw streamProtocolError("duplicate member")
    this.members.set(id, text.trim())
    return { id, text: text.trim() }
  }
  finish(): string[] {
    if (this.buffer) {
      this.line(this.buffer)
      this.buffer = ""
    }
    return Array.from({ length: this.count }, (_, id) => this.members.get(id) ?? "")
  }
}

/** Unknown/custom prompt framing falls back before any model dispatch. */
export function subtitleStreamStrategy(
  request: Pick<
    SubtitleBatchRequestPayload,
    "executionStrategy" | "providerRef" | "promptConfig" | "work"
  >,
) {
  return request.executionStrategy === "stream-v1" &&
    request.work?.lane !== "export" &&
    isLLMProviderConfig(request.providerRef.config) &&
    request.promptConfig &&
    Object.hasOwn(
      BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS,
      request.promptConfig.customPromptsConfig.promptId || DEFAULT_TRANSLATE_PROMPT_ID,
    )
    ? ("stream-v1" as const)
    : undefined
}
