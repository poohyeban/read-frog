import { TranslationCancelledError } from "@/utils/request/cancellation"

type Entry<T> =
  | { status: "pending"; promise: Promise<T>; controller: AbortController; consumers: Set<symbol> }
  | { status: "ready"; value: T }
  | { status: "cooldown"; error: unknown; until: number }

/** Bounded singleflight results; active work is reference-counted, not evicted. */
export class ContextCoordinator<T> {
  private entries = new Map<string, Entry<T>>()
  constructor(
    private readonly capacity = 16,
    private readonly cooldownMs = 30_000,
  ) {}

  get(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new TranslationCancelledError())
    let entry = this.entries.get(key)
    if (entry?.status === "ready") {
      this.entries.delete(key)
      this.entries.set(key, entry)
      return Promise.resolve(entry.value)
    }
    if (entry?.status === "cooldown") {
      if (entry.until > Date.now()) return Promise.reject(entry.error)
      this.entries.delete(key)
      entry = undefined
    }
    if (!entry) {
      const controller = new AbortController()
      const pending: Extract<Entry<T>, { status: "pending" }> = {
        status: "pending",
        controller,
        consumers: new Set(),
        promise: Promise.resolve(undefined as T),
      }
      this.entries.set(key, pending)
      pending.promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return load(controller.signal)
        })
        .then(
          (value) => {
            controller.signal.throwIfAborted()
            if (this.entries.get(key) === pending) this.entries.set(key, { status: "ready", value })
            this.prune()
            return value
          },
          (error) => {
            if (this.entries.get(key) === pending) {
              if (controller.signal.aborted) this.entries.delete(key)
              else
                this.entries.set(key, {
                  status: "cooldown",
                  error,
                  until: Date.now() + this.cooldownMs,
                })
            }
            this.prune()
            throw error
          },
        )
      entry = pending
    }
    const pending = entry
    const consumer = Symbol()
    pending.consumers.add(consumer)
    return new Promise<T>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener("abort", abort)
        pending.controller.signal.removeEventListener("abort", abort)
        pending.consumers.delete(consumer)
      }
      const abort = () => {
        release()
        reject(new TranslationCancelledError())
        if (pending.consumers.size === 0 && this.entries.get(key) === pending) {
          this.entries.delete(key)
          pending.controller.abort(new TranslationCancelledError())
        }
      }
      signal?.addEventListener("abort", abort, { once: true })
      pending.controller.signal.addEventListener("abort", abort, { once: true })
      pending.promise.then(
        (value) => {
          release()
          resolve(value)
        },
        (error) => {
          release()
          reject(error)
        },
      )
    })
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.status === "pending") entry.controller.abort(new TranslationCancelledError())
    }
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
  state(key: string): "idle" | Entry<T>["status"] {
    return this.entries.get(key)?.status ?? "idle"
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.status === "cooldown" && entry.until <= Date.now()) this.entries.delete(key)
      else if (this.entries.size > this.capacity && entry.status !== "pending")
        this.entries.delete(key)
    }
  }
}
