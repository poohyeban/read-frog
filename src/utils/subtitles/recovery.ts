import type { SubtitleTaskOptions } from "./session"
import type { SubtitleWorkContext } from "./work-policy"
import { SubtitleResultError, subtitleFailure, type SubtitleOutcome } from "./result"

/** Retry only a structured, pre-admission restart rejection; never replay an ambiguous RPC. */
export async function runSubtitleRequest<T>(
  task: SubtitleTaskOptions,
  work: SubtitleWorkContext | undefined,
  send: (work: SubtitleWorkContext | undefined) => Promise<T>,
): Promise<T> {
  for (let recovery = 0; ; recovery++) {
    task.signal?.throwIfAborted()
    try {
      return await send(work)
    } catch (error) {
      const outcome = subtitleFailure(error)
      if (outcome.status === "success" || outcome.status === "empty") throw error
      if (outcome.code === "lease-expired" && recovery === 0 && work && task.recoverWork) {
        work = await task.recoverWork(work)
        continue
      }
      // A lost response might already have consumed Provider resources. Only a
      // structured outcome can authorize delayed business recovery.
      throw new SubtitleResultError({
        ...outcome,
        retryExhausted:
          outcome.retryExhausted ||
          !(error instanceof SubtitleResultError) ||
          outcome.code === "lease-expired",
      })
    }
  }
}

interface Failure {
  outcome: SubtitleOutcome
  failures: number
  retryAt: number
  expiresAt: number
}
/** Per source member/window. At most two delayed recoveries in a two-minute lifetime. */
export class SubtitleFailures {
  private entries = new Map<string, Failure>()
  record(key: string, outcome: SubtitleOutcome, now = Date.now()) {
    if (outcome.status === "success" || outcome.status === "empty") return this.delete(key)
    const previous = this.entries.get(key)
    const failures = (previous?.failures ?? 0) + 1
    const expiresAt = previous?.expiresAt ?? now + 120_000
    const delay = Math.max(1000 * 2 ** (failures - 1), outcome.retryAfterMs ?? 0)
    const retryAt =
      outcome.status === "temporary" &&
      !outcome.retryExhausted &&
      failures <= 2 &&
      now + delay <= expiresAt
        ? now + delay
        : Infinity
    this.entries.set(key, { outcome, failures, retryAt, expiresAt })
  }
  has(key: string) {
    return this.entries.has(key)
  }
  blocked(key: string, now = Date.now()) {
    const entry = this.entries.get(key)
    return !!entry && (entry.retryAt > now || entry.expiresAt < now)
  }
  nextRetryAt() {
    let next = Infinity
    for (const entry of this.entries.values())
      if (entry.retryAt > Date.now() && entry.retryAt <= entry.expiresAt)
        next = Math.min(next, entry.retryAt)
    return next
  }
  delete(key: string) {
    this.entries.delete(key)
  }
  clear() {
    this.entries.clear()
  }
}
