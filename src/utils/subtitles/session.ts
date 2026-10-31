import type { SubtitleLane, SubtitleWorkContext } from "./work-policy"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { sendMessage } from "@/utils/message"
import { TranslationCancelledError } from "@/utils/request/cancellation"

export type SubtitleTaskKind = "playback" | "segmentation" | "context" | "export"
export interface SubtitleTaskOptions {
  kind?: SubtitleTaskKind
  lane?: SubtitleLane
  sessionId?: string
  signal?: AbortSignal
  priority?: number
  work?: SubtitleWorkContext
  prepareWork?: (lane: SubtitleLane, start: number, end: number) => Promise<SubtitleWorkContext>
}
export interface SubtitleTask extends SubtitleTaskOptions {
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly kind: SubtitleTaskKind
  readonly key: string
  isCurrent: () => boolean
  complete: () => void
  cancel: () => void
}

/** Resource owner for one video/track. Queues retain shared-request refcounts. */
export class SubtitleSession {
  readonly id = getRandomUUID()
  private epoch = 0
  private active = true
  private disposed = false
  private tasks = new Set<SubtitleTask>()
  private disposers = new Set<() => void>()
  private leasePromise?: Promise<string>
  private stopping: Promise<void> = Promise.resolve()
  readonly identity: Readonly<{ videoId: string; trackId: string; revision: number }>

  constructor(identity = { videoId: "", trackId: "", revision: 0 }) {
    this.identity = Object.freeze({ ...identity })
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.dispose)
  }
  own(dispose: () => void) {
    this.disposers.add(dispose)
    return () => this.disposers.delete(dispose)
  }
  get isActive() {
    return this.active && !this.disposed
  }
  start() {
    if (this.disposed) throw new TranslationCancelledError(this.id)
    if (!this.active) {
      this.active = true
      this.epoch++
    }
  }
  begin(
    kind: SubtitleTaskKind,
    key: string,
    priority = kind === "playback" ? 0 : kind === "segmentation" ? 1 : 3,
  ): SubtitleTask {
    if (!this.active || this.disposed) throw new TranslationCancelledError(this.id)
    const epoch = this.epoch
    const controller = new AbortController()
    const sessionId = `subtitle:${this.id}:${kind}:${getRandomUUID()}`
    let completed = false
    const task: SubtitleTask = {
      sessionId,
      priority,
      kind,
      key,
      signal: controller.signal,
      prepareWork: async (lane, start, end) => {
        if (!task.isCurrent()) throw new TranslationCancelledError(sessionId)
        const lease = await (this.leasePromise ??= sendMessage("openSubtitleLease", {
          traceId: this.id,
        }))
        if (!task.isCurrent()) throw new TranslationCancelledError(sessionId)
        return { lease, lane, start, end, urgent: priority === 0, logicalKey: key }
      },
      isCurrent: () =>
        !completed &&
        this.active &&
        !this.disposed &&
        epoch === this.epoch &&
        !controller.signal.aborted,
      complete: () => {
        completed = true
        this.tasks.delete(task)
        void sendMessage("releaseSubtitleTask", { sessionId }).catch(() => {})
      },
      cancel: () => {
        if (completed) return
        controller.abort(new TranslationCancelledError(sessionId))
        completed = true
        this.tasks.delete(task)
        // No receiver after extension reload/tab close is expected; never retry indefinitely.
        void sendMessage("cancelSubtitleRequests", { sessionId }).catch(() => {})
      },
    }
    this.tasks.add(task)
    return task
  }
  cancel(kind?: SubtitleTaskKind) {
    for (const task of [...this.tasks]) if (!kind || task.kind === kind) task.cancel()
  }
  stop(): Promise<void> {
    this.active = false
    this.epoch++
    this.cancel()
    const lease = this.leasePromise
    this.leasePromise = undefined
    this.stopping = Promise.all([
      this.stopping,
      lease?.then((id) => sendMessage("revokeSubtitleLease", { lease: id })),
    ]).then(() => {})
    // Callers can await confirmation; fire-and-forget destruction must not leak rejections.
    void this.stopping.catch(() => {})
    return this.stopping
  }
  dispose = () => {
    if (this.disposed) return
    void this.stop()
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.disposers.clear()
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.dispose)
  }
  get taskCount() {
    return this.tasks.size
  }
}
