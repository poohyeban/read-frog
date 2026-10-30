import { yieldToMain } from "@/utils/scheduler"

type Work = {
  iterator: Generator<unknown, unknown>
  current: () => boolean
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  promise: Promise<unknown>
  foreground: boolean
  signal?: AbortSignal
  detach: () => void
  executing: boolean
  cancelled: boolean
}

/** One page-local loop budgets synchronous expansion, never network completion. */
export class LocalScheduler {
  private tasks = new Map<object, Work>()
  private foreground = new Map<object, Work>()
  private background = new Map<object, Work>()
  private running = false
  constructor(
    private readonly budgetMs = 8,
    private readonly yieldMain = yieldToMain,
  ) {}

  run<T>(
    iterator: Generator<unknown, T>,
    options: {
      key?: object
      current?: () => boolean
      foreground?: boolean
      signal?: AbortSignal
    } = {},
  ): Promise<T | undefined> {
    if (options.signal?.aborted) {
      iterator.return(undefined as T)
      return Promise.resolve(undefined)
    }
    let key = options.key ?? iterator
    const existing = this.tasks.get(key)
    if (existing?.signal === options.signal && existing) return existing.promise as Promise<T>
    // Deduplication must never let one consumer cancel another owner's work.
    if (existing) key = iterator
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T | undefined>((res, rej) => {
      resolve = res as (value: unknown) => void
      reject = rej
    })
    const task: Work = {
      iterator,
      current: options.current ?? (() => true),
      resolve,
      reject,
      promise,
      foreground: options.foreground ?? false,
      signal: options.signal,
      detach: () => options.signal?.removeEventListener("abort", cancel),
      executing: false,
      cancelled: false,
    }
    const cancel = () => {
      task.cancelled = true
      this.remove(key, task)
      try {
        // Abort may be raised inside next(); closing a running generator throws.
        if (!task.executing) task.iterator.return(undefined)
        task.resolve(undefined)
      } catch (error) {
        task.reject(error)
      }
    }
    options.signal?.addEventListener("abort", cancel, { once: true })
    this.tasks.set(key, task)
    ;(task.foreground ? this.foreground : this.background).set(key, task)
    if (!this.running) {
      this.running = true
      void this.drain()
    }
    return promise
  }

  schedule<T>(
    callback: () => T,
    current: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    return this.run(
      (function* () {
        yield
        return callback()
      })(),
      { current, foreground: true, signal },
    )
  }

  get pending(): number {
    return this.tasks.size
  }

  private remove(key: object, task: Work): void {
    if (this.tasks.get(key) !== task) return
    this.tasks.delete(key)
    this.foreground.delete(key)
    this.background.delete(key)
    task.detach()
  }

  private async drain(): Promise<void> {
    let deadline = performance.now() + this.budgetMs
    let foregroundTurns = 0
    try {
      while (this.tasks.size) {
        if (performance.now() >= deadline) {
          await this.yieldMain()
          deadline = performance.now() + this.budgetMs
          if (!this.tasks.size) break
        }
        const queue =
          this.foreground.size && (foregroundTurns < 4 || !this.background.size)
            ? this.foreground
            : this.background
        const [key, task] = queue.entries().next().value!
        foregroundTurns = task.foreground ? foregroundTurns + 1 : 0
        queue.delete(key)
        try {
          if (!task.current() || task.signal?.aborted) {
            this.remove(key, task)
            task.iterator.return(undefined)
            task.resolve(undefined)
          } else {
            task.executing = true
            let next: IteratorResult<unknown>
            try {
              next = task.iterator.next()
            } finally {
              task.executing = false
            }
            if (task.cancelled) task.iterator.return(undefined)
            else if (next.done) {
              this.remove(key, task)
              task.resolve(next.value)
            } else queue.set(key, task)
          }
        } catch (error) {
          this.remove(key, task)
          task.reject(error)
        }
        // Admit resumed consumers before the next budget check. Do not await
        // their network promises: RequestQueue retains network concurrency.
        await Promise.resolve()
      }
    } catch (error) {
      // A failed yield must not leave the scheduler permanently marked running.
      for (const [key, task] of this.tasks) {
        this.remove(key, task)
        try {
          task.iterator.return(undefined)
        } catch {
          /* preserve dispatch error */
        }
        task.reject(error)
      }
    } finally {
      this.running = false
    }
  }
}

export const pageLocalScheduler = new LocalScheduler()
