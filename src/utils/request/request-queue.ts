import type { RequestRetryPolicy } from "./retry-policy"
import { deepmerge } from "deepmerge-ts"
import { requestQueueConfigSchema } from "@/types/config/translate"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { TranslationCancelledError } from "./cancellation"
import { BinaryHeapPQ } from "./priority-queue"
import { defaultRequestRetryPolicy } from "./retry-policy"

export interface RequestTask {
  id: string
  thunk: (signal?: AbortSignal) => Promise<any>
  promise: Promise<any>
  resolve: (value: any) => void
  reject: (error: any) => void
  scheduleAt: number
  createdAt: number
  retryCount: number
  // 429 retries spent on this task; a separate budget from retryCount (see
  // RequestRetryContext.rateLimitRetryCount).
  rateLimitRetryCount: number
  drained: boolean
  // Per-task timeout override; falls back to QueueOptions.timeoutMs. Large
  // LLM batches need proportionally more time than single requests.
  timeoutMs?: number
}

type QueuedRequestTask = RequestTask & {
  hash: string
  abortController?: AbortController
  // Cancellation scopes subscribed to this task. Dedup can attach several
  // (same hash from multiple tabs/sessions); the task is only cancelled when
  // its LAST scope is cancelled. `null` means an unscoped subscriber exists,
  // which pins the task as uncancellable.
  cancelScopes: Set<string> | null
}

export interface QueueOptions {
  rate: number // tokens/sec
  capacity: number // token bucket size
  /** Independent attempt limit. Omitted preserves the existing unlimited behavior. */
  maxConcurrent?: number
  timeoutMs: number
  maxRetries: number
  baseRetryDelayMs: number
  retryPolicy?: RequestRetryPolicy
}

export class RequestQueue {
  private waitingQueue: BinaryHeapPQ<QueuedRequestTask>
  private waitingTasks = new Map<string, QueuedRequestTask>()
  private executingTasks = new Map<string, QueuedRequestTask>()
  private nextScheduleTimer: NodeJS.Timeout | null = null
  private retryPolicy: RequestRetryPolicy
  private activeAttempts = new Set<symbol>()
  private dispatchListeners = new Set<() => void>()

  // token bucket
  private bucketTokens: number
  private lastRefill: number

  // rate-limit pause: no dispatching while Date.now() < pausedUntil. Set on a
  // 429 (pause-and-retry decision); the backlog stays intact instead of being
  // mass-rejected.
  private pausedUntil = 0
  // Pause windows since the last successful request; feeds the retry policy's
  // give-up cap (MAX_CONSECUTIVE_RATE_LIMIT_PAUSES).
  private consecutiveRateLimits = 0

  constructor(private options: QueueOptions) {
    this.validateConcurrency(options.maxConcurrent)
    this.retryPolicy = options.retryPolicy ?? defaultRequestRetryPolicy
    this.bucketTokens = options.capacity
    this.lastRefill = Date.now()
    this.waitingQueue = new BinaryHeapPQ<QueuedRequestTask>()
  }

  enqueue<T>(
    thunk: (signal?: AbortSignal) => Promise<T>,
    scheduleAt: number,
    hash: string,
    scopes?: readonly string[],
    taskOptions?: { timeoutMs?: number },
  ): Promise<T> {
    const duplicateTask = this.duplicateTask(hash)
    if (duplicateTask) {
      // console.info(`🔄 Found duplicate task for hash: ${hash}, returning existing promise`)
      if (!scopes?.length) {
        duplicateTask.cancelScopes = null
      } else if (duplicateTask.cancelScopes !== null) {
        scopes.forEach((scope) => duplicateTask.cancelScopes!.add(scope))
      }
      return duplicateTask.promise
    }

    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    const task: QueuedRequestTask = {
      id: getRandomUUID(),
      hash,
      thunk,
      promise,
      resolve,
      reject,
      scheduleAt,
      createdAt: Date.now(),
      retryCount: 0,
      rateLimitRetryCount: 0,
      drained: false,
      timeoutMs: taskOptions?.timeoutMs,
      cancelScopes: scopes?.length ? new Set(scopes) : null,
    }

    this.waitingTasks.set(hash, task)
    this.waitingQueue.push(task, scheduleAt)

    // console.info(`✅ Task ${task.id} added to queue. Queue size: ${this.waitingQueue.size()}, waiting: ${this.waitingTasks.size}, executing: ${this.executingTasks.size}`)

    this.schedule()
    return promise
  }

  subscribeDispatch(listener: () => void): () => void {
    this.dispatchListeners.add(listener)
    return () => {
      this.dispatchListeners.delete(listener)
    }
  }

  private notifyDispatch() {
    for (const listener of [...this.dispatchListeners]) listener()
  }

  setQueueOptions(options: Partial<QueueOptions>) {
    if (Object.hasOwn(options, "maxConcurrent")) this.validateConcurrency(options.maxConcurrent)
    const { retryPolicy, ...queueOptions } = options
    const parseConfigStatus = requestQueueConfigSchema.partial().safeParse(queueOptions)
    if (parseConfigStatus.error) {
      throw new Error(parseConfigStatus.error.issues[0]!.message)
    }
    // Settle token accrual under the OLD rate before switching.
    this.refillTokens()
    this.options = deepmerge(this.options, queueOptions) as QueueOptions
    if (Object.hasOwn(options, "maxConcurrent")) this.options.maxConcurrent = options.maxConcurrent
    if (retryPolicy) {
      this.retryPolicy = retryPolicy
    }
    // Clamp, never refill-to-full: a capacity edit must not grant a free
    // burst, and repeated identical calls (config sync) must be no-ops.
    this.bucketTokens = Math.min(this.bucketTokens, this.options.capacity)
    // The pending timer's delay was computed under the old rate — recompute.
    this.schedule()
    this.notifyDispatch()
  }

  /**
   * Cancel every task subscribed to the given scope. Refcounted: a task shared
   * with another scope (dedup) or with an unscoped subscriber survives; only
   * tasks whose LAST scope this is are rejected/aborted (#1881).
   */
  cancelByScope(scopeKey: string): number {
    return this.cancelWhere((scope) => scope === scopeKey)
  }

  /**
   * Cancel every task all of whose scopes match the predicate. Unscoped tasks
   * (`cancelScopes === null`) never match.
   */
  cancelWhere(scopeMatches: (scopeKey: string) => boolean): number {
    let cancelled = 0

    const cancelMatchingScopes = (task: QueuedRequestTask): boolean => {
      if (task.cancelScopes === null) return false
      let matchedScope: string | undefined
      for (const scope of task.cancelScopes) {
        if (scopeMatches(scope)) {
          matchedScope = scope
          task.cancelScopes.delete(scope)
        }
      }
      if (matchedScope === undefined || task.cancelScopes.size > 0) return false
      this.rejectDrainedTask(task, new TranslationCancelledError(matchedScope))
      return true
    }

    for (const [hash, task] of [...this.waitingTasks]) {
      if (!cancelMatchingScopes(task)) continue
      this.waitingTasks.delete(hash)
      cancelled++
    }
    this.waitingQueue.removeWhere((task) => task.drained)

    for (const [hash, task] of [...this.executingTasks]) {
      if (!cancelMatchingScopes(task)) continue
      this.executingTasks.delete(hash)
      cancelled++
    }

    if (cancelled > 0) {
      this.schedule()
    }
    return cancelled
  }

  /**
   * Milliseconds until this queue could START one more (newly enqueued)
   * request: accounts for the rate-limit pause, available tokens, and the
   * requests already waiting ahead of it. 0 = a slot is available now.
   * Consumed by the BatchQueue's dispatch gate so batches keep filling while
   * dispatch is blocked instead of flushing tiny.
   */
  nextDispatchEtaMs(): number {
    if (!this.hasAvailableSlot()) return Infinity
    this.refillTokens()
    const now = Date.now()
    const pauseDelayMs = Math.max(0, this.pausedUntil - now)
    const tokensNeeded = this.waitingQueue.size() + 1
    const tokenDelayMs =
      this.bucketTokens >= tokensNeeded
        ? 0
        : Math.ceil(((tokensNeeded - this.bucketTokens) / this.options.rate) * 1000)
    return Math.max(pauseDelayMs, tokenDelayMs)
  }

  private schedule() {
    this.refillTokens()
    this.clearScheduleTimer()

    const pauseRemainingMs = this.pausedUntil - Date.now()
    if (pauseRemainingMs > 0) {
      if (this.waitingQueue.size() > 0) {
        this.armScheduleTimer(pauseRemainingMs)
      }
      return
    }

    while (this.hasAvailableSlot() && this.bucketTokens >= 1 && this.waitingQueue.size() > 0) {
      const now = Date.now()

      const task = this.waitingQueue.peek()
      if (task?.drained) {
        // Safety net: a drained task should have been removed from the heap,
        // but never dispatch or let one stall the timer computation below.
        this.waitingQueue.pop()
        this.waitingTasks.delete(task.hash)
        continue
      }
      if (task && task.scheduleAt <= now) {
        this.waitingQueue.pop()
        this.waitingTasks.delete(task.hash)
        this.executingTasks.set(task.hash, task)
        this.bucketTokens--
        void this.executeTask(task)
      } else {
        break
      }
    }

    if (this.hasAvailableSlot() && this.waitingQueue.size() > 0) {
      const nextTask = this.waitingQueue.peek()
      if (nextTask) {
        const now = Date.now()
        const delayUntilScheduled = Math.max(0, nextTask.scheduleAt - now)
        const msUntilNextToken =
          this.bucketTokens >= 1
            ? 0
            : Math.ceil(((1 - this.bucketTokens) / this.options.rate) * 1000)
        const delay = Math.max(delayUntilScheduled, msUntilNextToken)

        this.armScheduleTimer(delay)
      }
    }
  }

  private clearScheduleTimer() {
    if (this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }
  }

  private armScheduleTimer(delayMs: number) {
    this.nextScheduleTimer = setTimeout(() => {
      this.nextScheduleTimer = null
      this.schedule()
    }, delayMs)
  }

  private validateConcurrency(value: number | undefined) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error("maxConcurrent must be a positive integer or undefined")
    }
  }

  private hasAvailableSlot(): boolean {
    return this.activeAttempts.size < (this.options.maxConcurrent ?? Infinity)
  }

  private async executeTask(task: QueuedRequestTask) {
    const attempt = Symbol("request attempt")
    this.activeAttempts.add(attempt)
    const abortController = new AbortController()
    task.abortController = abortController
    const timeoutMs = task.timeoutMs ?? this.options.timeoutMs
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let transportSettled = false
    let transport: Promise<unknown> | undefined
    let rejectAborted!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject
    })
    const onAbort = () => rejectAborted(abortController.signal.reason)
    abortController.signal.addEventListener("abort", onAbort, { once: true })

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true
          const error = new Error(`Task ${task.id} timed out after ${timeoutMs}ms`)
          reject(error)
          abortController.abort(error)
        }, timeoutMs)
      })
      try {
        transport = Promise.resolve(task.thunk(abortController.signal))
      } catch (error) {
        transport = Promise.reject(error)
      }
      void transport.then(
        () => {
          transportSettled = true
        },
        () => {
          transportSettled = true
        },
      )
      const result = await Promise.race([transport, timeout, aborted])
      this.consecutiveRateLimits = 0
      if (!task.drained) task.resolve(result)
    } catch (error) {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      if (task.drained) return

      if (timedOut && !transportSettled && transport && this.options.maxRetries > 0) {
        // AbortSignal is cooperative. Give fetch a bounded opportunity to settle,
        // but never overlap an unconfirmed abort with an automatic retry. A
        // broken transport must not leave the logical queue permanently locked.
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          transport.then(
            () => {},
            () => {},
          ),
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, 100)
          }),
        ])
        if (graceTimer !== undefined) clearTimeout(graceTimer)
        if (task.drained) return
        if (!transportSettled) {
          task.reject(error)
          return
        }
      }

      const now = Date.now()
      const decision = this.retryPolicy.decide(error, {
        retryCount: task.retryCount,
        maxRetries: this.options.maxRetries,
        baseRetryDelayMs: this.options.baseRetryDelayMs,
        now,
        rateLimitRetryCount: task.rateLimitRetryCount,
        consecutiveRateLimits: this.consecutiveRateLimits,
      })
      if (decision.action === "retry") {
        task.retryCount++
        task.scheduleAt = now + decision.delayMs
        this.waitingTasks.set(task.hash, task)
        this.waitingQueue.push(task, task.scheduleAt)
      } else if (decision.action === "pause-and-retry") {
        if (now >= this.pausedUntil) this.consecutiveRateLimits++
        this.pausedUntil = Math.max(this.pausedUntil, now + decision.pauseMs)
        this.bucketTokens = Math.min(this.bucketTokens, 1)
        this.lastRefill = now
        task.rateLimitRetryCount++
        task.scheduleAt = this.pausedUntil
        this.waitingTasks.set(task.hash, task)
        this.waitingQueue.push(task, task.scheduleAt)
      } else if (decision.failQueue) {
        this.failCurrentBacklog(error)
      } else {
        task.reject(error)
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      abortController.signal.removeEventListener("abort", onAbort)
      if (task.abortController === abortController) task.abortController = undefined
      if (this.executingTasks.get(task.hash) === task) this.executingTasks.delete(task.hash)
      this.activeAttempts.delete(attempt)
      // Re-enqueued retries cannot begin until this attempt's cleanup finishes.
      this.schedule()
      this.notifyDispatch()
    }
  }

  private duplicateTask(hash: string) {
    const duplicateTask = this.waitingTasks.get(hash) ?? this.executingTasks.get(hash)
    if (duplicateTask) {
      return duplicateTask
    }
    return undefined
  }

  private failCurrentBacklog(error: unknown) {
    // A fresh user retry after this mass-fail gets a fresh pause budget, but
    // pausedUntil is kept: new enqueues still respect the provider's cooldown.
    this.consecutiveRateLimits = 0
    if (this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }

    for (const task of this.waitingTasks.values()) {
      this.rejectDrainedTask(task, error)
    }
    this.waitingTasks.clear()
    this.waitingQueue.clear()

    for (const task of this.executingTasks.values()) {
      this.rejectDrainedTask(task, error)
    }
    this.executingTasks.clear()
  }

  private rejectDrainedTask(task: QueuedRequestTask, error: unknown) {
    if (task.drained) {
      return
    }

    task.drained = true
    task.reject(error)
    task.abortController?.abort(error)
  }

  private refillTokens() {
    const now = Date.now()
    // Earn at most one probe token during a cooldown, never a full burst.
    const pausedElapsed = Math.max(0, Math.min(now, this.pausedUntil) - this.lastRefill)
    if (pausedElapsed > 0) {
      this.bucketTokens = Math.min(
        1,
        this.bucketTokens + (pausedElapsed / 1000) * this.options.rate,
      )
    }
    const timeSinceLastRefill = Math.max(0, now - Math.max(this.lastRefill, this.pausedUntil))
    const tokensToAdd = (timeSinceLastRefill / 1000) * this.options.rate
    this.bucketTokens = Math.min(this.bucketTokens + tokensToAdd, this.options.capacity)

    // if (tokensToAdd > 0.01) { // Only log if meaningful tokens were added
    //   console.log(`🪣 Token bucket refilled: ${oldTokens.toFixed(2)} -> ${this.bucketTokens.toFixed(2)} (+${tokensToAdd.toFixed(2)}) after ${timeSinceLastRefill}ms`)
    // }

    this.lastRefill = now
  }
}
