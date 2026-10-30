import { isTranslationCancelledError } from "@/utils/request/cancellation"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"

export type SubtitleOutcome =
  | { status: "success" }
  | { status: "empty" }
  | { status: "temporary" | "permanent" | "cancelled"; message: string; retryAfterMs?: number }

export function subtitleFailure(error: unknown): SubtitleOutcome {
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
