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

type FailureOutcome = Exclude<SubtitleOutcome, { status: "success" } | { status: "empty" }>
interface Failure {
  outcome: FailureOutcome
  failures: number
  retryAt: number
}
export type SubtitleFailureState =
  | "clear"
  | "waiting"
  | "ready"
  | "exhausted"
  | "manual"
  | "cancelled"

/** At most two safe intake recoveries per source per session. Elapsed time never resets the budget. */
export class SubtitleFailures {
  private entries = new Map<string, Failure>()
  record(key: string, outcome: SubtitleOutcome, now = Date.now()) {
    if (outcome.status === "success" || outcome.status === "empty") return this.delete(key)
    const failures = (this.entries.get(key)?.failures ?? 0) + 1
    const delay = Math.max(1000 * 2 ** Math.min(failures - 1, 30), outcome.retryAfterMs ?? 0)
    const retryAt =
      outcome.status === "temporary" && !outcome.retryExhausted && failures <= 2
        ? now + delay
        : Infinity
    this.entries.set(key, { outcome, failures, retryAt })
  }
  has(key: string) {
    return this.entries.has(key)
  }
  state(key: string, now = Date.now()): SubtitleFailureState {
    const entry = this.entries.get(key)
    if (!entry) return "clear"
    if (entry.outcome.status === "cancelled") return "cancelled"
    if (entry.outcome.status === "permanent") return "manual"
    if (!Number.isFinite(entry.retryAt)) return "exhausted"
    return now < entry.retryAt ? "waiting" : "ready"
  }
  blocked(key: string, now = Date.now()) {
    const state = this.state(key, now)
    return state !== "clear" && state !== "ready"
  }
  nextRetryAt() {
    let next = Infinity
    for (const entry of this.entries.values())
      if (entry.retryAt > Date.now()) next = Math.min(next, entry.retryAt)
    return next
  }
  delete(key: string) {
    this.entries.delete(key)
  }
  clear() {
    this.entries.clear()
  }
}
