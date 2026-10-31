import type {
  SubtitleBudgetLimits,
  SubtitleModelGuard,
  SubtitleWorkContext,
} from "@/utils/subtitles/work-policy"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { emptyBudget, reserveBudget } from "@/utils/subtitles/work-budget"
import {
  DEFAULT_SUBTITLE_BUDGET,
  estimateInputTokens,
  SUBTITLE_WORK_LIMITS,
  SubtitleWorkRejected,
} from "@/utils/subtitles/work-policy"
import { ensureInitializedConfig } from "./config"

interface Lease {
  trace: string
  tab: number
  budget: string
  limits?: { requests: number; estimatedTokens: number }
}
interface RegisteredWork {
  registeredAt: number
  scope: string
  context: SubtitleWorkContext
}
export interface SubtitleDiagnosticEvent {
  time: number
  event: string
  lane?: string
  value?: number
  scope?: string
  mediaTimeMs?: number
}

/** One instance per background boot. Persistent debit survives; execution authority does not. */
export class SubtitleWorkRuntime {
  private leases = new Map<string, Lease>()
  private work = new Map<string, RegisteredWork>()
  private events: SubtitleDiagnosticEvent[] = []
  private enabled = false
  private counters: Record<string, number> = {}
  hasLease(tab: number | undefined, id: string) {
    return tab !== undefined && this.leases.get(id)?.tab === tab
  }

  open(
    tab: number,
    exportLimits?: { requests: number; estimatedTokens: number },
    traceId?: string,
  ): string {
    if (this.leases.size >= 256) throw new SubtitleWorkRejected("queue-full")
    if (
      exportLimits &&
      (!Number.isSafeInteger(exportLimits.requests) ||
        exportLimits.requests < 1 ||
        exportLimits.requests > 100_000 ||
        !Number.isSafeInteger(exportLimits.estimatedTokens) ||
        exportLimits.estimatedTokens < 1 ||
        exportLimits.estimatedTokens > 1_000_000_000)
    )
      throw new SubtitleWorkRejected("input-limit")
    const id = getRandomUUID()
    this.leases.set(id, {
      trace: this.traceIdentity(tab, traceId ?? id),
      tab,
      budget: exportLimits ? `export:${id}` : "playback",
      limits: exportLimits,
    })
    return id
  }
  register(tab: number, scope: string, context: SubtitleWorkContext) {
    if (
      !["fast", "quality", "segmentation", "context", "export"].includes(context.lane) ||
      typeof context.urgent !== "boolean"
    )
      throw new SubtitleWorkRejected("input-limit")
    const lease = this.leases.get(context.lease)
    if (!lease || lease.tab !== tab) throw new SubtitleWorkRejected("lease")
    if (!this.work.has(scope) && this.work.size >= 512) throw new SubtitleWorkRejected("queue-full")
    this.work.set(scope, {
      scope,
      context,
      registeredAt: this.work.get(scope)?.registeredAt ?? Date.now(),
    })
  }
  release(scope: string, cancelled = false) {
    if (this.work.delete(scope) && cancelled) this.note("cancel")
  }
  revoke(tab: number, id: string): string[] {
    if (this.leases.get(id)?.tab !== tab) return []
    this.leases.delete(id)
    const scopes = [...this.work.values()].filter((w) => w.context.lease === id).map((w) => w.scope)
    for (const scope of scopes) this.work.delete(scope)
    this.note("cancel", undefined, scopes.length)
    return scopes
  }
  closeTab(tab: number): string[] {
    return [...this.leases].flatMap(([id, lease]) =>
      lease.tab === tab ? this.revoke(tab, id) : [],
    )
  }
  private live(scopes: readonly string[] | undefined): RegisteredWork[] {
    return (scopes ?? []).flatMap((scope) => {
      const work = this.work.get(scope)
      return work && this.leases.has(work.context.lease) ? [work] : []
    })
  }
  traceIdentity(tab: number, id: string) {
    return Sha256Hex(String(tab), id).slice(0, 12)
  }
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
  async status() {
    return {
      ledger: (await db.subtitleBudget.get("playback")) ?? emptyBudget("playback"),
      ...this.snapshot(),
    }
  }

  guard(
    scopes: () => readonly string[] | undefined,
    keys: readonly string[],
    signal?: AbortSignal,
  ): SubtitleModelGuard {
    let chargedBudget: string | undefined
    let queuedAt = Date.now()
    let scopeTrace: string | undefined
    let lane: string | undefined
    let reserved = false
    let retrying = false
    let startedAt: number | undefined
    const cancelled = () => this.note("provider-cancel", lane, 1, { scope: scopeTrace })
    return {
      beforeCall: async (input, outputTokens) => {
        reserved = false
        signal?.throwIfAborted()
        if (
          input.length > SUBTITLE_WORK_LIMITS.promptCharacters ||
          !Number.isFinite(outputTokens) ||
          outputTokens < 1 ||
          outputTokens > SUBTITLE_WORK_LIMITS.outputTokens
        )
          throw new SubtitleWorkRejected("input-limit")
        const config = await ensureInitializedConfig()
        const policy: SubtitleBudgetLimits =
          config?.videoSubtitles.workBudget ?? DEFAULT_SUBTITLE_BUDGET
        this.setDiagnostics(policy.diagnostics)
        try {
          await db.transaction("rw", db.subtitleBudget, db.subtitleAttempt, async () => {
            signal?.throwIfAborted()
            const subscribers = this.live(scopes())
            if (!subscribers.length) throw new SubtitleWorkRejected("lease")
            // Prefer a still-live urgent consumer; a stopped exporter cannot fund playback.
            const owner = subscribers.find((w) => w.context.urgent) ?? subscribers[0]!
            const lease = this.leases.get(owner.context.lease)!
            queuedAt = owner.registeredAt
            scopeTrace = lease.trace
            lane = owner.context.lane
            const budget = lease.budget
            const limits = lease.limits ?? policy
            const attemptKeys = [...new Set(keys)].map((key) => `${budget}:${key}`)
            const ledger = (await db.subtitleBudget.get(budget)) ?? emptyBudget(budget)
            const attempts = await Promise.all(
              attemptKeys.map(
                async (key) => (await db.subtitleAttempt.get(key)) ?? { key, count: 0 },
              ),
            )
            signal?.throwIfAborted()
            if (!this.leases.has(owner.context.lease) || !this.live(scopes()).length)
              throw new SubtitleWorkRejected("lease")
            reserveBudget(ledger, attempts, {
              budget,
              keys: attemptKeys,
              tokens: estimateInputTokens(input) + outputTokens,
              urgent: owner.context.urgent || !!lease.limits,
              maxRequests: limits.requests,
              maxTokens: limits.estimatedTokens,
              emergencyPercent: lease.limits ? 0 : policy.emergencyPercent,
            })
            await db.subtitleBudget.put(ledger)
            await db.subtitleAttempt.bulkPut(attempts)
            chargedBudget = budget
            retrying = attempts.some((a) => a.count > 1)
            this.note(
              "reserved-tokens",
              owner.context.lane,
              estimateInputTokens(input) + outputTokens,
              { scope: scopeTrace },
            )
          })
          signal?.throwIfAborted()
          if (!this.live(scopes()).length) throw new SubtitleWorkRejected("lease")
          reserved = true
          this.note("dispatch-authorized", this.live(scopes())[0]?.context.lane)
        } catch (error) {
          if (error instanceof SubtitleWorkRejected) this.note(`rejected:${error.code}`)
          throw error
        }
      },
      onDispatch: () => {
        signal?.throwIfAborted()
        if (!reserved || !this.live(scopes()).length) throw new SubtitleWorkRejected("lease")
        reserved = false
        startedAt = Date.now()
        signal?.addEventListener("abort", cancelled, { once: true })
        this.note("queue-wait-ms", lane, Date.now() - queuedAt, { scope: scopeTrace })
        this.note("batch-members", lane, keys.length, { scope: scopeTrace })
        this.note("provider-start", lane, 1, { scope: scopeTrace })
        if (retrying) this.note("retry", lane, 1, { scope: scopeTrace })
      },
      usage: async (usage) => {
        signal?.removeEventListener("abort", cancelled)
        if (startedAt !== undefined) {
          this.note("provider-complete", lane, 1, { scope: scopeTrace })
          this.note("provider-latency-ms", lane, Date.now() - startedAt, { scope: scopeTrace })
        }
        if (!chargedBudget) return
        await db.transaction("rw", db.subtitleBudget, async () => {
          const ledger = await db.subtitleBudget.get(chargedBudget!)
          if (!ledger) return
          const valid = (n: number | undefined) => (Number.isFinite(n) && n! >= 0 ? n! : 0)
          ledger.actualInputTokens += valid(usage.inputTokens)
          ledger.actualOutputTokens += valid(usage.outputTokens)
          if (usage.inputTokens !== undefined)
            this.note("usage-input-tokens", lane, valid(usage.inputTokens), { scope: scopeTrace })
          if (usage.outputTokens !== undefined)
            this.note("usage-output-tokens", lane, valid(usage.outputTokens), { scope: scopeTrace })
          if (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
            ledger.usageReports++
          await db.subtitleBudget.put(ledger)
        })
      },
    }
  }
}

export const subtitleWorkRuntime = new SubtitleWorkRuntime()
