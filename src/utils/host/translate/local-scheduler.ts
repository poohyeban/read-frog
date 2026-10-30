import { yieldToMain } from "@/utils/scheduler"

type Work = {
  iterator: Generator<unknown, unknown>
  current: () => boolean
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  promise: Promise<unknown>
  foreground: boolean
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
    options: { key?: object; current?: () => boolean; foreground?: boolean } = {},
  ): Promise<T | undefined> {
    const key = options.key ?? iterator
    const existing = this.tasks.get(key)
    if (existing) return existing.promise as Promise<T>
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T | undefined>((res, rej) => {
      resolve = res as (value: unknown) => void
      reject = rej
    })
    const task = {
      iterator,
      current: options.current ?? (() => true),
      resolve,
      reject,
      promise,
      foreground: options.foreground ?? false,
    }
    this.tasks.set(key, task)
    ;(task.foreground ? this.foreground : this.background).set(key, task)
    if (!this.running) {
      this.running = true
      void this.drain()
    }
    return promise
  }

  schedule<T>(callback: () => T, current: () => boolean = () => true): Promise<T | undefined> {
    return this.run(
      (function* () {
        yield
        return callback()
      })(),
      { current, foreground: true },
    )
  }

  get pending(): number {
    return this.tasks.size
  }

  private async drain(): Promise<void> {
    let deadline = performance.now() + this.budgetMs
    let foregroundTurns = 0
    // A microtask boundary after each step admits the resumed consumer's local
    // work before the next budget check. Resolving an entire wave at once would
    // let all consumers pass the budget and block the next frame together.
    while (this.tasks.size) {
      if (performance.now() >= deadline) {
        await this.yieldMain()
        deadline = performance.now() + this.budgetMs
      }
      const queue =
        this.foreground.size && (foregroundTurns < 4 || !this.background.size)
          ? this.foreground
          : this.background
      const [key, task] = queue.entries().next().value!
      foregroundTurns = task.foreground ? foregroundTurns + 1 : 0
      queue.delete(key)
      try {
        if (!task.current()) {
          this.tasks.delete(key)
          task.iterator.return(undefined)
          task.resolve(undefined)
        } else {
          const next = task.iterator.next()
          if (next.done) {
            this.tasks.delete(key)
            task.resolve(next.value)
          } else queue.set(key, task)
        }
      } catch (error) {
        this.tasks.delete(key)
        task.reject(error)
      }
      await Promise.resolve()
    }
    this.running = false
  }
}

export const pageLocalScheduler = new LocalScheduler()
