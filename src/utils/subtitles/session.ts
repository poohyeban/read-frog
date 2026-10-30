import { getRandomUUID } from "@/utils/crypto-polyfill"
import { sendMessage } from "@/utils/message"
import { TranslationCancelledError } from "@/utils/request/cancellation"

export type SubtitleTaskKind = "playback" | "segmentation" | "context" | "export"
export interface SubtitleTaskOptions {
  sessionId?: string
  signal?: AbortSignal
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
  begin(kind: SubtitleTaskKind, key: string): SubtitleTask {
    if (!this.active || this.disposed) throw new TranslationCancelledError(this.id)
    const epoch = this.epoch
    const controller = new AbortController()
    const sessionId = `subtitle:${this.id}:${kind}:${getRandomUUID()}`
    let completed = false
    const task: SubtitleTask = {
      sessionId,
      kind,
      key,
      signal: controller.signal,
      isCurrent: () =>
        !completed &&
        this.active &&
        !this.disposed &&
        epoch === this.epoch &&
        !controller.signal.aborted,
      complete: () => {
        completed = true
        this.tasks.delete(task)
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
  stop() {
    this.active = false
    this.epoch++
    this.cancel()
  }
  dispose = () => {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.disposers.clear()
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.dispose)
  }
  get taskCount() {
    return this.tasks.size
  }
}
