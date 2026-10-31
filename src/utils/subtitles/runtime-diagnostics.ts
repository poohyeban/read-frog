/** Bounded, optional telemetry. No counters participate in request admission. */
export interface SubtitleDiagnosticEvent {
  time: number
  event: string
  lane?: string
  value?: number
  scope?: string
  mediaTimeMs?: number
}

export class SubtitleDiagnostics {
  private events: SubtitleDiagnosticEvent[] = []
  private enabled = false
  private counters: Record<string, number> = {}
  private scopeCounters = new Map<string, Record<string, number>>()
  setDiagnostics(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) this.events = []
  }
  note(event: string, lane?: string, value = 1, detail?: { scope?: string; mediaTimeMs?: number }) {
    this.counters[event] = (this.counters[event] ?? 0) + value
    if (detail?.scope) {
      const counters = this.scopeCounters.get(detail.scope) ?? {}
      const key = lane ? `${event}:${lane}` : event
      counters[key] = (counters[key] ?? 0) + value
      this.scopeCounters.set(detail.scope, counters)
      if (this.scopeCounters.size > 256)
        this.scopeCounters.delete(this.scopeCounters.keys().next().value!)
    }
    if (!this.enabled) return
    this.events.push({ time: Date.now(), event, lane, value, ...detail })
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000)
  }
  snapshot() {
    return {
      counters: { ...this.counters },
      events: [...this.events],
      sessions: Object.fromEntries(this.scopeCounters),
    }
  }
}
