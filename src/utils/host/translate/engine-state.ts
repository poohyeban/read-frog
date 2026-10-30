import { isTranslationCancelledError } from "@/utils/request/cancellation"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"

export type TranslationWorkPhase = "context" | "request" | "render"
export type TranslationPhase =
  | "idle"
  | "discovering"
  | "preparing-context"
  | "translating"
  | "rendering"
  | "settled"
  | "cancelled"
  | "error"
export interface TranslationIssue {
  readonly kind: "cancelled" | "unstable-context" | "protocol" | "request"
  readonly retryable: boolean
  readonly retryAfterMs?: number
}
export interface TranslationEngineSnapshot {
  readonly sessionId: string | null
  readonly phase: TranslationPhase
  /** Lazy viewport translation has no knowable whole-page percentage. */
  readonly progressScope: "observed-work"
  readonly pending: Readonly<Record<TranslationWorkPhase, number>>
  readonly completedRequests: number
  readonly committedResults: number
  readonly failedTasks: number
  readonly cancelledTasks: number
  readonly lastIssue?: TranslationIssue
}
export interface TranslationCommands {
  readonly isActive: boolean
  start: () => Promise<void>
  stop: (options?: { userInitiated?: boolean }) => void
}
export interface TranslationEngine extends TranslationCommands {
  getSnapshot: () => TranslationEngineSnapshot
  subscribe: (listener: () => void) => () => void
}
export function classifyTranslationIssue(error: unknown): TranslationIssue {
  const code = (error as { code?: string } | null)?.code
  if (isTranslationCancelledError(error) || (error instanceof Error && error.name === "AbortError"))
    return { kind: "cancelled", retryable: false }
  if (code === "CONTEXT_UNSTABLE")
    return { kind: "unstable-context", retryable: true, retryAfterMs: 1000 }
  if (code === "HTML_ATTR_MARKER_INTEGRITY") return { kind: "protocol", retryable: true }
  const meta = getRequestErrorMeta(error)
  return { kind: "request", retryable: meta.isRetryable ?? false, retryAfterMs: meta.retryAfterMs }
}

/** A bounded read model of engine activity, never a scheduler or session owner.
 * Notifications coalesce at 50ms; snapshots are immutable and stable between changes. */
export class TranslationActivity {
  private sessionId: string | null = null
  private stopped = false
  private pending = { context: 0, request: 0, render: 0 }
  private completedRequests = 0
  private committedResults = 0
  private failedTasks = 0
  private cancelledTasks = 0
  private lastIssue?: TranslationIssue
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private snapshot?: TranslationEngineSnapshot

  begin(sessionId: string): void {
    this.sessionId = sessionId
    this.stopped = false
    this.pending = { context: 0, request: 0, render: 0 }
    this.completedRequests = this.committedResults = this.failedTasks = this.cancelledTasks = 0
    this.lastIssue = undefined
    this.changed()
  }
  end(sessionId: string): void {
    if (this.sessionId !== sessionId) return
    this.cancelledTasks += Object.values(this.pending).reduce((sum, value) => sum + value, 0)
    this.pending = { context: 0, request: 0, render: 0 }
    this.stopped = true
    this.changed()
  }
  track(kind: TranslationWorkPhase, sessionId?: string): (error?: unknown) => void {
    if (!sessionId || sessionId !== this.sessionId || this.stopped) return () => {}
    this.pending[kind]++
    this.changed()
    let finished = false
    return (error) => {
      if (finished || this.stopped || sessionId !== this.sessionId) return
      finished = true
      this.pending[kind]--
      if (error !== undefined) {
        const issue = classifyTranslationIssue(error)
        if (issue.kind === "cancelled") this.cancelledTasks++
        else {
          this.failedTasks++
          this.lastIssue = Object.freeze(issue)
        }
      } else if (kind === "request") this.completedRequests++
      else if (kind === "render") this.committedResults++
      this.changed()
    }
  }
  getSnapshot = (): TranslationEngineSnapshot => {
    if (this.snapshot) return this.snapshot
    const phase: TranslationPhase = this.stopped
      ? "cancelled"
      : !this.sessionId
        ? "idle"
        : this.pending.context
          ? "preparing-context"
          : this.pending.request
            ? "translating"
            : this.pending.render
              ? "rendering"
              : this.failedTasks
                ? "error"
                : this.completedRequests || this.committedResults
                  ? "settled"
                  : "discovering"
    return (this.snapshot = Object.freeze({
      sessionId: this.sessionId,
      phase,
      progressScope: "observed-work",
      pending: Object.freeze({ ...this.pending }),
      completedRequests: this.completedRequests,
      committedResults: this.committedResults,
      failedTasks: this.failedTasks,
      cancelledTasks: this.cancelledTasks,
      lastIssue: this.lastIssue,
    }))
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
    }
  }
  private changed(): void {
    this.snapshot = undefined
    if (!this.listeners.size || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const listener of this.listeners) {
        try {
          listener()
        } catch (error) {
          console.warn("Translation state subscriber failed", error)
        }
      }
    }, 50)
  }
}
export const translationActivity = new TranslationActivity()
