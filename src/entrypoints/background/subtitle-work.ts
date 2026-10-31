import type { SubtitleModelGuard, SubtitleWorkContext } from "@/utils/subtitles/work-policy"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { Sha256Hex } from "@/utils/hash"
import { SubtitleDiagnostics } from "@/utils/subtitles/runtime-diagnostics"
import {
  estimateInputTokens,
  SUBTITLE_WORK_LIMITS,
  SubtitleWorkRejected,
} from "@/utils/subtitles/work-policy"
export type { SubtitleDiagnosticEvent } from "@/utils/subtitles/runtime-diagnostics"

interface Lease {
  trace: string
  tab: number
}
interface RegisteredWork {
  registeredAt: number
  scope: string
  context: SubtitleWorkContext
}

/** Boot-local execution authority. A worker restart invalidates every old lease. */
export class SubtitleWorkRuntime extends SubtitleDiagnostics {
  private leases = new Map<string, Lease>()
  private work = new Map<string, RegisteredWork>()
  hasLease(tab: number | undefined, id: string) {
    return tab !== undefined && this.leases.get(id)?.tab === tab
  }

  open(tab: number, traceId?: string): string {
    if (this.leases.size >= 256) throw new SubtitleWorkRejected("queue-full")
    const id = getRandomUUID()
    this.leases.set(id, { trace: this.traceIdentity(tab, traceId ?? id), tab })
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
  guard(
    scopes: () => readonly string[] | undefined,
    keys: readonly string[],
    signal?: AbortSignal,
  ): SubtitleModelGuard {
    let prepared = false
    let queuedAt = Date.now()
    let scopeTrace: string | undefined
    let lane: string | undefined
    let startedAt: number | undefined
    const cancelled = () => this.note("provider-cancel", lane, 1, { scope: scopeTrace })
    const assertLive = () => {
      signal?.throwIfAborted()
      const subscribers = this.live(scopes())
      if (!subscribers.length) throw new SubtitleWorkRejected("lease")
      return subscribers.find((w) => w.context.urgent) ?? subscribers[0]!
    }
    return {
      beforeCall: async (input, outputTokens) => {
        prepared = false
        const owner = assertLive()
        if (
          input.length > SUBTITLE_WORK_LIMITS.promptCharacters ||
          !Number.isFinite(outputTokens) ||
          outputTokens < 1 ||
          outputTokens > SUBTITLE_WORK_LIMITS.outputTokens
        )
          throw new SubtitleWorkRejected("input-limit")
        queuedAt = owner.registeredAt
        lane = owner.context.lane
        scopeTrace = this.leases.get(owner.context.lease)!.trace
        this.note("estimated-input-tokens", lane, estimateInputTokens(input), { scope: scopeTrace })
        prepared = true
      },
      onDispatch: () => {
        assertLive()
        if (!prepared) throw new SubtitleWorkRejected("lease")
        prepared = false
        startedAt = Date.now()
        signal?.addEventListener("abort", cancelled, { once: true })
        this.note("queue-wait-ms", lane, startedAt - queuedAt, { scope: scopeTrace })
        this.note("batch-members", lane, keys.length, { scope: scopeTrace })
        this.note("provider-start", lane, 1, { scope: scopeTrace })
      },
      usage: async (usage) => {
        signal?.removeEventListener("abort", cancelled)
        if (startedAt !== undefined) {
          this.note("provider-complete", lane, 1, { scope: scopeTrace })
          this.note("provider-latency-ms", lane, Date.now() - startedAt, { scope: scopeTrace })
        }
        for (const [kind, count] of [
          ["input", usage.inputTokens],
          ["output", usage.outputTokens],
        ] as const)
          if (count !== undefined && Number.isFinite(count) && count >= 0)
            this.note(`usage-${kind}-tokens`, lane, count, { scope: scopeTrace })
      },
    }
  }
}
export const subtitleWorkRuntime = new SubtitleWorkRuntime()
