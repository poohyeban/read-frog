import { getRandomUUID } from "@/utils/crypto-polyfill"
import { AttemptContext } from "./attempt-context"
import { TranslationCancelledError } from "./cancellation"
import { batchOverridesSchema } from "./performance-config"
import { ResourceRejected } from "./resource-error"

export class BatchCountMismatchError extends Error {
  readonly isRetryable = false
  constructor(expected: number, got: number, _results: unknown[]) {
    super(`Batch result count mismatch: expected ${expected}, got ${got}.`)
    this.name = "BatchCountMismatchError"
  }
}

export class BatchMemberInvalidError extends Error {
  readonly isRetryable = false
  constructor() {
    super("Invalid batch member result")
    this.name = "BatchMemberInvalidError"
  }
}

interface BatchTask<T, R> {
  memberId: string
  data: T
  resolve: (value: R) => void
  reject: (error: Error) => void
  // Same refcounting contract as QueuedRequestTask.cancelScopes: `null` pins
  // the task (an unscoped subscriber exists); otherwise the task is cancelled
  // only when its last scope is cancelled.
  cancelScopes: Set<string> | null
  // Set once the batch has been handed to executeBatch: its scope snapshot is
  // now frozen downstream, so late dedup subscribers must NOT join it (#1881).
  flushed: boolean
}

interface PendingBatch<T, R> {
  id: string
  tasks: BatchTask<T, R>[]
  totalCharacters: number
  createdAt: number
}

export interface BatchExecutionMeta {
  attempts: AttemptContext
  /**
   * Union of the live members' cancellation scopes at flush time, or
   * `undefined` when any member is uncancellable. Thread this into the
   * downstream RequestQueue so cancelling the scopes aborts the whole batch.
   */
  scopes: readonly string[] | undefined
}

export interface BatchOptions<T, R> {
  maxPending?: number
  maxCharactersPerBatch: number
  maxItemsPerBatch: number
  batchDelay: number
  enableFallbackToIndividual?: boolean
  getBatchKey: (data: T) => string
  getCharacters: (data: T) => number
  getDedupKey?: (data: T) => string | undefined
  getScope?: (data: T) => string | undefined
  // Liveness check for a scope whose cancel may have run while a flushed
  // batch was outside every cancellable structure (retry backoff sleep).
  isScopeCancelled?: (scopeKey: string) => boolean
  executeBatch: (dataList: T[], meta: BatchExecutionMeta) => Promise<R[]>
  /** Validate aligned members only after the complete result count is known. */
  isResultValid?: (result: R, data: T) => boolean
  executeIndividual?: (data: T, meta: BatchExecutionMeta) => Promise<R>
  onError?: (
    error: Error,
    context: { batchKey: string; retryCount: number; isFallback: boolean },
  ) => void
}

export class BatchQueue<T, R> {
  private maxPending: number
  private outstanding = 0
  private pendingBatchMap = new Map<string, PendingBatch<T, R>>()
  private inFlightTasks = new Map<string, { promise: Promise<R>; task: BatchTask<T, R> }>()
  private nextScheduleTimer: NodeJS.Timeout | null = null
  private maxCharactersPerBatch: number
  private maxItemsPerBatch: number
  private batchDelay: number
  private enableFallbackToIndividual: boolean
  private getBatchKey: (data: T) => string
  private getCharacters: (data: T) => number
  private getDedupKey?: (data: T) => string | undefined
  private getScope?: (data: T) => string | undefined
  private isScopeCancelled?: (scopeKey: string) => boolean
  private executeBatch: (dataList: T[], meta: BatchExecutionMeta) => Promise<R[]>
  private isResultValid?: (result: R, data: T) => boolean
  private executeIndividual?: (data: T, meta: BatchExecutionMeta) => Promise<R>
  private onError?: (
    error: Error,
    context: { batchKey: string; retryCount: number; isFallback: boolean },
  ) => void

  constructor(config: BatchOptions<T, R>) {
    this.maxPending = config.maxPending ?? 128
    this.maxCharactersPerBatch = config.maxCharactersPerBatch
    this.maxItemsPerBatch = config.maxItemsPerBatch
    this.batchDelay = config.batchDelay
    this.enableFallbackToIndividual = config.enableFallbackToIndividual ?? true
    this.getBatchKey = config.getBatchKey
    this.getCharacters = config.getCharacters
    this.getDedupKey = config.getDedupKey
    this.getScope = config.getScope
    this.isScopeCancelled = config.isScopeCancelled
    this.executeBatch = config.executeBatch
    this.isResultValid = config.isResultValid
    this.executeIndividual = config.executeIndividual
    this.onError = config.onError
  }

  enqueue(data: T): Promise<R> {
    const scope = this.getScope?.(data)
    const dedupKey = this.getDedupKey?.(data)
    if (dedupKey) {
      const inFlight = this.inFlightTasks.get(dedupKey)
      // Only join a still-pending batch: its cancelScopes set is mutable and
      // its flush-time union will include this scope. A flushed batch has
      // already handed a FROZEN scope snapshot to the RequestQueue, so a late
      // cross-scope subscriber joining it would be cancelled when the original
      // scope cancels — silently dropping this (still-active) session's
      // paragraph. Fall through to a fresh task instead; the RequestQueue's own
      // hash dedup re-coalesces identical batches, so the common case (two tabs
      // on the same page) stays deduped, and at worst one duplicate request is
      // issued for a genuinely different batch (#1881).
      if (inFlight && !inFlight.task.flushed) {
        if (!scope) {
          inFlight.task.cancelScopes = null
        } else if (inFlight.task.cancelScopes !== null) {
          inFlight.task.cancelScopes.add(scope)
        }
        return inFlight.promise
      }
    }

    if (this.outstanding >= this.maxPending)
      return Promise.reject(new ResourceRejected("queue-full"))
    this.outstanding++
    let resolve!: (value: R) => void
    let reject!: (error: Error) => void
    const promise = new Promise<R>((res, rej) => {
      resolve = res
      reject = rej
    })
    void promise.then(
      () => {
        this.outstanding--
      },
      () => {
        this.outstanding--
      },
    )

    const batchKey = this.getBatchKey(data)
    const task: BatchTask<T, R> = {
      memberId: dedupKey ?? getRandomUUID(),
      data,
      resolve,
      reject,
      cancelScopes: scope ? new Set([scope]) : null,
      flushed: false,
    }

    if (dedupKey) {
      this.inFlightTasks.set(dedupKey, { promise, task })
      const release = () => {
        if (this.inFlightTasks.get(dedupKey)?.promise === promise) {
          this.inFlightTasks.delete(dedupKey)
        }
      }
      promise.then(release, release)
    }

    this.addTaskToBatch(task, batchKey)
    this.schedule()

    return promise
  }

  /**
   * Cancel every not-yet-flushed member subscribed to the given scope (see
   * RequestQueue.cancelByScope for the refcounting contract). Batches already
   * flushed live as a single RequestQueue task carrying the scope union —
   * cancel them there.
   */
  cancelByScope(scopeKey: string): number {
    return this.cancelWhere((scope) => scope === scopeKey)
  }

  cancelWhere(scopeMatches: (scopeKey: string) => boolean): number {
    let cancelled = 0
    for (const [batchKey, batch] of [...this.pendingBatchMap]) {
      const kept: BatchTask<T, R>[] = []
      for (const task of batch.tasks) {
        const scopes = task.cancelScopes
        if (scopes === null) {
          kept.push(task)
          continue
        }
        let matchedScope: string | undefined
        for (const scope of scopes) {
          if (scopeMatches(scope)) {
            matchedScope = scope
            scopes.delete(scope)
          }
        }
        if (matchedScope === undefined || scopes.size > 0) {
          kept.push(task)
          continue
        }
        // inFlightTasks self-releases via the promise.then(release, release)
        // handler attached at enqueue time.
        task.reject(new TranslationCancelledError(matchedScope))
        cancelled++
      }
      if (kept.length === 0) {
        this.pendingBatchMap.delete(batchKey)
      } else if (kept.length !== batch.tasks.length) {
        batch.tasks = kept
        batch.totalCharacters = kept.reduce((sum, task) => sum + this.getCharacters(task.data), 0)
      }
    }
    if (this.pendingBatchMap.size === 0 && this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }
    return cancelled
  }

  private schedule() {
    if (this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }

    const now = Date.now()
    const batchesToFlush: string[] = []
    let nextWakeMs = Infinity

    for (const [batchKey, batch] of this.pendingBatchMap.entries()) {
      // Size-full: always flush — the batch's composition is already maximal.
      if (this.shouldFlushBatch(batch)) {
        batchesToFlush.push(batchKey)
        continue
      }

      const ageMs = now - batch.createdAt
      if (ageMs >= this.batchDelay) {
        batchesToFlush.push(batchKey)
        continue
      }
      const wakeMs = this.batchDelay - ageMs
      nextWakeMs = Math.min(nextWakeMs, wakeMs)
    }

    for (const batchKey of batchesToFlush) {
      this.flushPendingBatchByKey(batchKey)
    }

    if (this.pendingBatchMap.size > 0) {
      this.nextScheduleTimer = setTimeout(
        () => {
          this.nextScheduleTimer = null
          this.schedule()
        },
        Number.isFinite(nextWakeMs) ? nextWakeMs : this.batchDelay,
      )
    }
  }

  private addTaskToBatch(task: BatchTask<T, R>, batchKey: string) {
    const characters = this.getCharacters(task.data)
    const existingBatch = this.pendingBatchMap.get(batchKey)

    if (existingBatch) {
      if (existingBatch.totalCharacters + characters <= this.maxCharactersPerBatch) {
        existingBatch.tasks.push(task)
        existingBatch.totalCharacters += characters
      } else {
        this.flushPendingBatchByKey(batchKey)
        this.createNewPendingBatch(task, batchKey)
      }
    } else {
      this.createNewPendingBatch(task, batchKey)
    }
  }

  private shouldFlushBatch(batch: PendingBatch<T, R>): boolean {
    return (
      batch.tasks.length >= this.maxItemsPerBatch ||
      batch.totalCharacters >= this.maxCharactersPerBatch
    )
  }

  private createNewPendingBatch(task: BatchTask<T, R>, batchKey: string) {
    const batchId = getRandomUUID()

    const pendingBatch: PendingBatch<T, R> = {
      id: batchId,
      tasks: [task],
      totalCharacters: this.getCharacters(task.data),
      createdAt: Date.now(),
    }

    this.pendingBatchMap.set(batchKey, pendingBatch)
  }

  private flushPendingBatchByKey(batchKey: string) {
    const pendingBatch = this.pendingBatchMap.get(batchKey)
    if (!pendingBatch) return

    this.pendingBatchMap.delete(batchKey)

    const { tasks } = pendingBatch
    // Freeze the batch: from here its downstream scope snapshot is fixed, so
    // enqueue() must stop letting late subscribers dedup into these tasks.
    for (const task of tasks) task.flushed = true

    // Scope union frozen at flush time: if every member is scoped, cancelling
    // all those scopes downstream aborts the whole batch; one unscoped member
    // pins it (scopes: undefined).
    let scopes: string[] | undefined = []
    for (const task of tasks) {
      if (task.cancelScopes === null) {
        scopes = undefined
        break
      }
      scopes.push(...task.cancelScopes)
    }
    const meta: BatchExecutionMeta = {
      scopes: scopes ? [...new Set(scopes)] : undefined,
      attempts: AttemptContext.create(tasks.map((task) => task.memberId)),
    }

    void this.executeBatchWithRecovery(tasks, batchKey, meta)
  }

  private async executeBatchWithRecovery(
    tasks: BatchTask<T, R>[],
    batchKey: string,
    meta: BatchExecutionMeta,
  ): Promise<void> {
    try {
      const results = await this.executeBatch(
        tasks.map((task) => task.data),
        meta,
      )

      if (!results) {
        throw new Error("Batch execution results are undefined")
      }

      if (results.length !== tasks.length) {
        throw new BatchCountMismatchError(tasks.length, results.length, results)
      }

      const failed: BatchTask<T, R>[] = []
      tasks.forEach((task, index) => {
        const result = results[index]!
        if (this.isResultValid && !this.isResultValid(result, task.data)) failed.push(task)
        else task.resolve(result)
      })
      if (failed.length) {
        const error = new BatchMemberInvalidError()
        this.onError?.(error, { batchKey, retryCount: 0, isFallback: false })
        if (this.enableFallbackToIndividual && this.executeIndividual)
          return this.executeFallbackIndividual(failed, batchKey, meta.attempts)
        failed.forEach((task) => task.reject(error))
      }
    } catch (error) {
      const err = error as Error

      this.onError?.(err, { batchKey, retryCount: 0, isFallback: false })

      if (
        this.enableFallbackToIndividual &&
        this.executeIndividual &&
        err instanceof BatchCountMismatchError
      ) {
        // Same gate before the per-item fallback: the failed attempt's provider
        // call may have straddled the cancel.
        if (this.rejectIfAllScopesCancelled(tasks, meta)) return
        return this.executeFallbackIndividual(tasks, batchKey, meta.attempts)
      }

      tasks.forEach((task) => task.reject(err))
    }
  }

  /**
   * When every scope this batch was flushed with has since been cancelled,
   * reject all members with the cancellation error and report true. A batch
   * with an unscoped member (scopes: undefined) or any surviving scope keeps
   * running — same mixed-batch semantics as cancelByScope.
   */
  private rejectIfAllScopesCancelled(tasks: BatchTask<T, R>[], meta: BatchExecutionMeta): boolean {
    if (!this.isScopeCancelled || !meta.scopes || meta.scopes.length === 0) return false
    if (!meta.scopes.every((scope) => this.isScopeCancelled!(scope))) return false
    const error = new TranslationCancelledError(meta.scopes.join(","))
    tasks.forEach((task) => task.reject(error))
    return true
  }

  private async executeFallbackIndividual(
    tasks: BatchTask<T, R>[],
    batchKey: string,
    attempts: AttemptContext,
  ) {
    await Promise.allSettled(
      tasks.map(async (task) => {
        try {
          if (!this.executeIndividual) {
            throw new Error("executeIndividual is not defined")
          }
          // Pending dedup may have joined several subscribers onto one item.
          // Fallback must retain those scopes, not only the first sender's data.
          const scopes =
            task.cancelScopes === null
              ? undefined
              : [...task.cancelScopes].filter((scope) => !this.isScopeCancelled?.(scope))
          if (scopes?.length === 0) throw new TranslationCancelledError("fallback")
          const result = await this.executeIndividual(task.data, {
            scopes,
            attempts: attempts.subset([task.memberId]),
          })
          if (this.isResultValid && !this.isResultValid(result, task.data))
            throw new BatchMemberInvalidError()
          task.resolve(result)
        } catch (error) {
          const err = error as Error
          this.onError?.(err, { batchKey, retryCount: attempts.starts, isFallback: true })
          task.reject(err)
        }
      }),
    )
  }

  setBatchConfig(
    config: Partial<
      Pick<
        BatchOptions<T, R>,
        "maxCharactersPerBatch" | "maxItemsPerBatch" | "maxPending" | "batchDelay"
      >
    >,
  ) {
    const parseConfigStatus = batchOverridesSchema.safeParse(config)
    if (parseConfigStatus.error) {
      throw new Error(parseConfigStatus.error.issues[0]!.message)
    }

    this.maxCharactersPerBatch = config.maxCharactersPerBatch ?? this.maxCharactersPerBatch
    this.maxItemsPerBatch = config.maxItemsPerBatch ?? this.maxItemsPerBatch
    this.maxPending = config.maxPending ?? this.maxPending
    this.batchDelay = config.batchDelay ?? this.batchDelay
    this.schedule()
  }
}
