import { isTranslationCancelledError } from "@/utils/request/cancellation"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"

export type SubtitleOutcome =
  | { status: "success" }
  | { status: "empty" }
  | { status: "temporary" | "permanent" | "cancelled"; message: string; retryAfterMs?: number }

export type SubtitleWireResult = string | { translation?: string; outcome: SubtitleOutcome }
class SubtitleResultError extends Error {
  constructor(
    readonly outcome: Exclude<SubtitleOutcome, { status: "success" } | { status: "empty" }>,
  ) {
    super(outcome.message)
  }
}
export function unwrapSubtitleResult(result: SubtitleWireResult): string {
  if (typeof result === "string") return result
  if (result.outcome.status === "success" || result.outcome.status === "empty")
    return result.translation ?? ""
  throw new SubtitleResultError(result.outcome)
}

export function subtitleFailure(error: unknown): SubtitleOutcome {
  if (error instanceof SubtitleResultError) return error.outcome
  const message = error instanceof Error ? error.message : String(error)
  if (isTranslationCancelledError(error) || (error instanceof Error && error.name === "AbortError"))
    return { status: "cancelled", message }
  const meta = getRequestErrorMeta(error)
  const permanent =
    meta.isRetryable === false ||
    meta.kind === "bad-request" ||
    meta.kind === "access-denied" ||
    (meta.statusCode !== undefined && [400, 401, 403, 404, 422].includes(meta.statusCode))
  return { status: permanent ? "permanent" : "temporary", message, retryAfterMs: meta.retryAfterMs }
}
