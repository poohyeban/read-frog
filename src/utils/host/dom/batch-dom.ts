/** Frame-aligned writes have a bounded budget independent of network work. */
export interface DOMCommitOptions {
  signal?: AbortSignal
  current?: () => boolean
  onDiscard?: () => void
  onError?: (error: unknown) => void
}
type DOMOperation = () => void
type PendingWrite = { operation: DOMOperation; options: DOMCommitOptions; detach: () => void }

export class DOMBatcher {
  private operations = new Map<object, PendingWrite>()
  private rafId: number | null = null
  private isProcessing = false
  constructor(private readonly budgetMs = 4) {}

  queue(operation: DOMOperation, options: DOMCommitOptions = {}): void {
    if (options.signal?.aborted) {
      options.onDiscard?.()
      return
    }
    const key = {}
    const cancel = () => {
      if (!this.operations.delete(key)) return
      options.signal?.removeEventListener("abort", cancel)
      options.onDiscard?.()
      if (!this.operations.size && this.rafId !== null) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
    }
    this.operations.set(key, {
      operation,
      options,
      detach: () => options.signal?.removeEventListener("abort", cancel),
    })
    options.signal?.addEventListener("abort", cancel, { once: true })
    this.scheduleFlush()
  }
  get pending(): number {
    return this.operations.size
  }
  private scheduleFlush(): void {
    if (this.rafId !== null || this.isProcessing) return
    this.rafId = requestAnimationFrame(() => this.flush())
  }
  private flush(immediate = false): void {
    this.rafId = null
    this.isProcessing = true
    const deadline = performance.now() + this.budgetMs
    try {
      for (const [key, write] of this.operations) {
        this.operations.delete(key)
        write.detach()
        try {
          if (write.options.signal?.aborted || write.options.current?.() === false)
            write.options.onDiscard?.()
          else write.operation()
        } catch (error) {
          write.options.onError?.(error)
          console.error("Error executing batched DOM operation:", error)
        }
        if (!immediate && performance.now() >= deadline) break
      }
    } finally {
      this.isProcessing = false
      if (this.operations.size) this.scheduleFlush()
    }
  }
  flushImmediate(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.flush(true)
  }
}
const domBatcher = new DOMBatcher()
export function batchDOMOperation(operation: DOMOperation, options?: DOMCommitOptions): void {
  domBatcher.queue(operation, options)
}
/** Explicit synchronous restoration/testing escape hatch, never the normal render path. */
export function flushBatchedOperations(): void {
  domBatcher.flushImmediate()
}
export function createFragment(ownerDocument: Document = document): DocumentFragment {
  return ownerDocument.createDocumentFragment()
}
