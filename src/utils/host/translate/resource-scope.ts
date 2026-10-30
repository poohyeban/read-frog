/** Small ownership primitive, shared by sessions and independent context tasks. */
export class ResourceScope {
  private readonly controller = new AbortController()
  private readonly disposers = new Set<() => void>()
  get signal(): AbortSignal {
    return this.controller.signal
  }
  get size(): number {
    return this.disposers.size
  }
  own(dispose: () => void): () => void {
    if (this.signal.aborted) {
      dispose()
      return () => {}
    }
    this.disposers.add(dispose)
    return () => {
      this.disposers.delete(dispose)
    }
  }
  dispose(): unknown[] {
    if (this.signal.aborted) return []
    this.controller.abort()
    const errors: unknown[] = []
    for (const dispose of [...this.disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    this.disposers.clear()
    return errors
  }
}
