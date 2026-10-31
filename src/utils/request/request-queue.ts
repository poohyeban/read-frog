import type { ResourcePolicy } from "./resource-policy"
import type { RequestRetryPolicy } from "./retry-policy"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { AttemptContext } from "./attempt-context"
import { TranslationCancelledError } from "./cancellation"
import { bindExecutionContext, type RequestExecutionContext } from "./execution-context"
import { BinaryHeapPQ } from "./priority-queue"
import { ResourceRejected } from "./resource-error"
import { RESOURCE_DEFAULTS } from "./resource-policy"
import { defaultRequestRetryPolicy } from "./retry-policy"

export interface QueueOptions {
  onDeduplicate?: () => void
  onRetry?: (delayMs: number, rateLimited: boolean) => void
  timeoutMs: number
  maxRetries: number
  baseRetryDelayMs: number
  maxQueued?: number
  retryPolicy?: RequestRetryPolicy
  consumer?: string
}
export interface RequestTask {
  id: string
  hash: string
  thunk: (signal?: AbortSignal, liveScopes?: () => readonly string[] | undefined) => Promise<any>
  promise: Promise<any>
  resolve: (value: any) => void
  reject: (error: unknown) => void
  scheduleAt: number
  drained: boolean
  running: boolean
  scopes: Set<string> | null
  controller?: AbortController
  attempts: AttemptContext
  failures: number
  priority: number
  timeoutMs?: number
  policy?: ResourcePolicy
  context?: RequestExecutionContext
}

/** Logical requests and subscriptions only. No token bucket, physical slots or shared cooldown. */
export class RequestQueue {
  private scheduled = new BinaryHeapPQ<RequestTask>(undefined, true)
  private tasks = new Map<string, RequestTask>()
  private timer?: ReturnType<typeof setTimeout>
  constructor(private options: QueueOptions) {}

  enqueue<T>(
    thunk: (signal?: AbortSignal, liveScopes?: () => readonly string[] | undefined) => Promise<T>,
    scheduleAt: number,
    hash: string,
    scopes?: readonly string[],
    taskOptions?: { timeoutMs?: number; priority?: number; attempts?: AttemptContext },
  ): Promise<T> {
    const duplicate = this.tasks.get(hash)
    if (duplicate) {
      taskOptions?.attempts?.join(duplicate.attempts)
      this.options.onDeduplicate?.()
      if (!scopes?.length) duplicate.scopes = null
      else if (duplicate.scopes) scopes.forEach((scope) => duplicate.scopes!.add(scope))
      duplicate.priority = Math.min(duplicate.priority, taskOptions?.priority ?? 1)
      duplicate.context?.promote?.(duplicate.priority)
      return duplicate.promise
    }
    if (this.tasks.size >= (this.options.maxQueued ?? 64))
      return Promise.reject(new ResourceRejected("queue-full"))
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    const task: RequestTask = {
      id: getRandomUUID(),
      hash,
      thunk,
      promise,
      resolve,
      reject,
      scheduleAt,
      scopes: scopes?.length ? new Set(scopes) : null,
      attempts: taskOptions?.attempts ?? AttemptContext.create([hash]),
      failures: 0,
      priority: Math.min(3, Math.max(0, taskOptions?.priority ?? 1)),
      timeoutMs: taskOptions?.timeoutMs,
      running: false,
      drained: false,
    }
    this.tasks.set(hash, task)
    this.scheduled.push(task, scheduleAt)
    this.schedule()
    return promise
  }
  setQueueOptions(options: Partial<QueueOptions>) {
    if (
      options.maxQueued !== undefined &&
      (!Number.isInteger(options.maxQueued) || options.maxQueued < 1 || options.maxQueued > 4096)
    )
      throw new ResourceRejected("input-limit")
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 9)
    )
      throw new ResourceRejected("input-limit")
    this.options = { ...this.options, ...options }
    this.schedule()
  }
  cancelByScope(scope: string) {
    return this.cancelWhere((candidate) => candidate === scope)
  }
  cancelWhere(matches: (scope: string) => boolean) {
    let count = 0
    for (const task of this.tasks.values()) {
      if (!task.scopes || task.drained) continue
      let removed = false
      for (const scope of task.scopes)
        if (matches(scope)) {
          task.scopes.delete(scope)
          removed = true
        }
      if (!removed || task.scopes.size) continue
      count++
      this.drain(task, new TranslationCancelledError(task.hash))
    }
    this.schedule()
    return count
  }
  private drain(task: RequestTask, error: unknown) {
    if (task.drained) return
    task.drained = true
    task.reject(error)
    task.controller?.abort(error)
    if (!task.running) {
      this.scheduled.remove(task)
      this.tasks.delete(task.hash)
    }
  }
  private schedule() {
    clearTimeout(this.timer)
    this.timer = undefined
    const now = Date.now()
    while (this.scheduled.peek() && this.scheduled.peek()!.scheduleAt <= now) {
      const task = this.scheduled.pop()!
      if (!task.drained) void this.execute(task)
    }
    const next = this.scheduled.peek()
    if (next) this.timer = setTimeout(() => this.schedule(), Math.max(1, next.scheduleAt - now))
  }
  private async execute(task: RequestTask) {
    task.running = true
    const controller = new AbortController()
    task.controller = controller
    const context: RequestExecutionContext = {
      attempts: task.attempts,
      priority: task.priority,
      consumer: `${this.options.consumer ?? "request"}:${task.scopes?.values().next().value?.split(":").slice(0, 3).join(":") ?? "interactive"}`,
      requestKey: task.hash,
      timeoutMs: task.timeoutMs,
      policy: task.policy,
      abort: (reason) => this.drain(task, reason),
    }
    bindExecutionContext(controller.signal, context)
    task.context = context
    try {
      const result = await task.thunk(controller.signal, () =>
        task.scopes ? [...task.scopes] : undefined,
      )
      if (!task.drained) {
        task.drained = true
        task.resolve(result)
      }
    } catch (error) {
      if (task.drained || controller.signal.aborted) return
      // The scheduler may reject a timeout before an uncooperative transport has settled.
      // It calls context.abort in that case; never start a concurrent retry of that operation.
      if (context.physicalSettled) await context.physicalSettled
      if (task.drained || controller.signal.aborted) return
      task.policy = context.policy
      task.failures++
      const policy = task.policy
      const maxAttempts = policy?.maxAttempts ?? this.options.maxRetries + 1
      const decision = (this.options.retryPolicy ?? defaultRequestRetryPolicy).decide(error, {
        retryCount: Math.max(task.attempts.starts, task.failures) - 1,
        maxRetries: maxAttempts - 1,
        baseRetryDelayMs: policy?.baseRetryDelayMs ?? this.options.baseRetryDelayMs,
        maxRetryDelayMs: policy?.maxRetryDelayMs ?? RESOURCE_DEFAULTS.maxRetryDelayMs,
        now: Date.now(),
        cooldownMs: policy?.cooldownMs,
      })
      if (decision.action === "fail" || !task.attempts.canStart(maxAttempts)) {
        task.drained = true
        task.reject(error)
      } else {
        const delay = decision.action === "retry" ? decision.delayMs : decision.pauseMs
        this.options.onRetry?.(delay, decision.action === "pause-and-retry")
        task.scheduleAt = Date.now() + delay
        this.scheduled.push(task, task.scheduleAt)
      }
    } finally {
      const remove = () => {
        task.running = false
        if (task.drained && this.tasks.get(task.hash) === task) this.tasks.delete(task.hash)
        this.schedule()
      }
      // Dedup tombstones survive a caller's cancellation until actual client completion.
      if (context.physicalSettled) void context.physicalSettled.then(remove, remove)
      else remove()
    }
  }
}
