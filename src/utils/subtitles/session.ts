import type { SubtitleLane, SubtitleWorkContext } from "./work-policy"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { sendMessage } from "@/utils/message"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { openSubtitleLeaseConnection } from "./lease-connection"

export type SubtitleTaskKind = "playback" | "segmentation" | "context" | "export"
export interface SubtitleTaskOptions {
  executionStrategy?: "stream-v1"
  onProvisional?: (index: number, translation: string) => void
  onPreparationTiming?: (
    stage: "configuration" | "provider" | "lease" | "glossary" | "ipc",
    elapsedMs: number,
  ) => void
  kind?: SubtitleTaskKind
  lane?: SubtitleLane
  sessionId?: string
  signal?: AbortSignal
  priority?: number
  work?: SubtitleWorkContext
  recoverWork?: (work: SubtitleWorkContext) => Promise<SubtitleWorkContext>
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
  private leaseConnection?: ReturnType<typeof openSubtitleLeaseConnection>
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
  private acquireLease(): Promise<string> {
    if (!this.leasePromise) {
      let connection: ReturnType<typeof openSubtitleLeaseConnection> | undefined
      connection = openSubtitleLeaseConnection(this.id, () => {
        if (!connection || this.leaseConnection !== connection) return
        this.leaseConnection = undefined
        this.leasePromise = undefined
        // In-flight calls retain their own failure/attempt outcome. Never replay them here.
      })
      const pending = connection.lease
      this.leaseConnection = connection
      this.leasePromise = pending
      void pending.catch(() => {
        if (this.leasePromise === pending) this.leasePromise = undefined
      })
    }
    return this.leasePromise
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
        const lease = await this.acquireLease()
        if (!task.isCurrent()) throw new TranslationCancelledError(sessionId)
        return { lease, lane, start, end, urgent: priority === 0, logicalKey: key }
      },
      recoverWork: async (work) => {
        if (!task.isCurrent()) throw new TranslationCancelledError(sessionId)
        const pending = this.leasePromise
        const current = await pending
        if (!task.isCurrent()) throw new TranslationCancelledError(sessionId)
        // Compare the promise too: concurrent stale replies join the same replacement.
        if (current === work.lease && this.leasePromise === pending) {
          this.leasePromise = undefined
          const previous = this.leaseConnection
          this.leaseConnection = undefined
          previous?.close()
        }
        const lease = await this.acquireLease()
        if (!task.isCurrent()) throw new TranslationCancelledError(sessionId)
        return { ...work, lease }
      },
      isCurrent: () =>
        !completed &&
        this.active &&
        !this.disposed &&
        epoch === this.epoch &&
        !controller.signal.aborted,
      complete: () => {
        if (completed) return
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
    const connection = this.leaseConnection
    this.leaseConnection = undefined
    this.leasePromise = undefined
    connection?.close()
    // Closing the passive connection already revokes authority, even if the
    // acknowledgement RPC fails. Repeated Stop/Dispose joins that same outcome;
    // a new lease gets one new acknowledgement, never a backlog of old leases.
    if (!lease) return this.stopping
    this.stopping = this.stopping
      .catch(() => {})
      .then(async () => {
        // A rejected open never furnished authority to any request.
        const id = await lease.catch(() => undefined)
        if (id) await sendMessage("revokeSubtitleLease", { lease: id })
      })
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
