/** Shared by all RequestQueues in this background, including webpage and subtitles. */
export class ExecutionSlots {
  private paused = new Map<string, number>()
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  pause(provider: string, until: number) {
    const deadline = Math.max(until, this.paused.get(provider) ?? 0)
    this.paused.set(provider, deadline)
    clearTimeout(this.wakeTimers.get(provider))
    this.wakeTimers.set(
      provider,
      setTimeout(
        () => {
          this.paused.delete(provider)
          this.wakeTimers.delete(provider)
          for (const listener of [...this.listeners]) listener()
        },
        Math.max(1, deadline - Date.now()),
      ),
    )
  }
  private active = new Map<string, number>()
  private total = 0
  private listeners = new Set<() => void>()
  constructor(readonly maximum = 8) {}
  available(provider: string, limit: number) {
    return (
      (this.paused.get(provider) ?? 0) <= Date.now() &&
      this.total < this.maximum &&
      (this.active.get(provider) ?? 0) < limit
    )
  }
  acquire(provider: string, limit: number): (() => void) | undefined {
    if (!this.available(provider, limit)) return undefined
    this.total++
    this.active.set(provider, (this.active.get(provider) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.total--
      const count = this.active.get(provider)! - 1
      if (count) this.active.set(provider, count)
      else this.active.delete(provider)
      const listeners = [...this.listeners]
      // Rotate the first consumer so a continuously busy queue cannot always win.
      const first = listeners.shift()
      if (first) {
        listeners.push(first)
        this.listeners.delete(first)
        this.listeners.add(first)
      }
      for (const listener of listeners) listener()
    }
  }
  watch(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get inFlight() {
    return this.total
  }
}
export const providerExecutionSlots = new ExecutionSlots()
