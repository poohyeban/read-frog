import { getRandomUUID } from "@/utils/crypto-polyfill"
import { AttemptContext } from "./attempt-context"
import { BinaryHeapPQ } from "./priority-queue"
import { ResourceRejected } from "./resource-error"
import {
  GLOBAL_RESOURCE_DEFAULTS,
  resolveResourcePolicy,
  type ResourcePolicy,
} from "./resource-policy"

export interface ResourceDomainSpec {
  id: string
  policy: ResourcePolicy
}
interface Domain extends ResourceDomainSpec {
  tokens: number
  refillAt: number
  cooldownUntil: number
  active: Set<string>
  queued: number
  waiters: Set<Lane>
}
export interface ExecutionPermit {
  readonly physicalRequestId: string
  /** Validate and charge exactly once immediately before the actual network send. */
  start: (beforeSend?: () => void) => void
  cooldown?: (until: number, scope: "credential" | "shared") => readonly string[]
}
export interface ResourceRequest {
  resourceId: string
  consumer: string
  priority?: number
  signal?: AbortSignal
  attempts?: AttemptContext
  timeoutMs?: number
  assertCurrent?: () => void
  onSettled?: () => void
  onAbort?: (reason: unknown) => void
  onQueued?: (promote: (priority: number) => void) => void
}
interface Entry {
  id: string
  options: ResourceRequest
  score: number
  createdAt: number
  agingMs: number
  lane: Lane
  queuedDomains: Domain[]
  controller: AbortController
  run: (signal: AbortSignal, permit: ExecutionPermit) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
  drained: boolean
  running: boolean
}
interface Lane {
  key: string
  resourceId: string
  tasks: BinaryHeapPQ<Entry>
  blocked: Set<Domain>
}
interface Active {
  entry: Entry
  domains: Set<Domain>
  chargedDomains: Set<Domain>
  started: boolean
  released: boolean
}

/** One background authority. Queue objects never own copies of these physical resources. */
export class ResourceScheduler {
  private domains = new Map<string, Domain>()
  private paths = new Map<string, readonly string[]>()
  private lanes = new Map<string, Lane>()
  private ready = new BinaryHeapPQ<Lane>(undefined, true)
  private deadlines = new BinaryHeapPQ<Domain>(undefined, true)
  private wakeAt = new Map<Domain, number>()
  private active = new Map<string, Active>()
  private transitions = new Map<string, Map<Domain, Set<string>>>()
  private global: { maxInFlight: number; maxQueued: number } = { ...GLOBAL_RESOURCE_DEFAULTS }
  private pending = 0
  private timer?: ReturnType<typeof setTimeout>
  private pumping = false
  private initialized = false
  private referenced = new Set<string>()
  readonly counters = {
    starts: 0,
    cancellations: 0,
    rejected: 0,
    admissions: 0,
    eligibilityChecks: 0,
    maxActive: 0,
    maxQueued: 0,
  }

  configure(
    specs: readonly ResourceDomainSpec[],
    paths: ReadonlyMap<string, readonly string[]>,
    global = this.global,
  ) {
    if (
      !Number.isInteger(global.maxInFlight) ||
      global.maxInFlight < 1 ||
      global.maxInFlight > 128 ||
      !Number.isInteger(global.maxQueued) ||
      global.maxQueued < 1 ||
      global.maxQueued > 4096
    )
      throw new ResourceRejected("input-limit")
    const now = Date.now()
    for (const spec of specs) resolveResourcePolicy(spec.policy)
    for (const spec of specs) {
      let domain = this.domains.get(spec.id)
      if (domain) {
        this.refill(domain, now)
        domain.policy = spec.policy
        domain.tokens = Math.min(domain.tokens, spec.policy.capacity)
      } else {
        domain = {
          ...spec,
          tokens: this.initialized ? 0 : spec.policy.capacity,
          refillAt: now,
          cooldownUntil: 0,
          active: new Set(),
          queued: 0,
          waiters: new Set(),
        }
        this.domains.set(spec.id, domain)
      }
    }
    for (const ids of paths.values())
      if (ids.some((id) => !this.domains.has(id))) throw new ResourceRejected("identity")
    this.global = { ...global }
    this.paths = new Map(paths)
    this.referenced = new Set([...paths.values()].flat())
    // Configuration events may walk bounded active/queued work; dispatch never scans all jobs.
    for (const [id, running] of this.active) {
      const resource = running.entry.options.resourceId
      const current = new Set(this.currentDomains(resource))
      const transition = this.transitions.get(resource) ?? new Map<Domain, Set<string>>()
      for (const old of running.domains)
        if (!current.has(old)) {
          const holders = transition.get(old) ?? new Set<string>()
          holders.add(id)
          transition.set(old, holders)
        }
      if (transition.size) this.transitions.set(resource, transition)
      for (const domain of current)
        if (!running.domains.has(domain)) {
          running.domains.add(domain)
          domain.active.add(id)
        }
    }
    for (const domain of this.domains.values()) domain.queued = 0
    for (const lane of this.lanes.values()) {
      for (const entry of this.entriesForLane(lane)) {
        entry.queuedDomains = this.requiredDomains(entry.options.resourceId)
        for (const domain of entry.queuedDomains) domain.queued++
      }
      this.refresh(lane)
    }
    this.initialized = true
    this.collect()
    this.pump()
  }

  private waiting = new Map<string, Set<Entry>>()
  private entriesForLane(lane: Lane) {
    return this.waiting.get(lane.key) ?? []
  }
  policy(resourceId: string): ResourcePolicy {
    const policies = this.currentDomains(resourceId).map((d) => d.policy)
    if (!policies.length) throw new ResourceRejected("identity")
    return {
      ...policies[0]!,
      maxAttempts: Math.min(...policies.map((p) => p.maxAttempts)),
      timeoutMs: Math.min(...policies.map((p) => p.timeoutMs)),
      baseRetryDelayMs: Math.max(...policies.map((p) => p.baseRetryDelayMs)),
      maxRetryDelayMs: Math.min(...policies.map((p) => p.maxRetryDelayMs)),
    }
  }
  run<T>(
    options: ResourceRequest,
    run: (signal: AbortSignal, permit: ExecutionPermit) => Promise<T>,
  ): Promise<T> {
    try {
      options.signal?.throwIfAborted()
      options.assertCurrent?.()
      const domains = this.requiredDomains(options.resourceId)
      if (!this.paths.has(options.resourceId) || !domains.length)
        throw new ResourceRejected("identity")
      if (
        this.pending >= this.global.maxQueued ||
        domains.some((d) => d.queued >= d.policy.maxQueued)
      )
        throw new ResourceRejected("queue-full")
      const key = `${options.resourceId}:${options.consumer}`
      let lane = this.lanes.get(key)
      if (!lane) {
        lane = {
          key,
          resourceId: options.resourceId,
          tasks: new BinaryHeapPQ<Entry>(undefined, true),
          blocked: new Set(),
        }
        this.lanes.set(key, lane)
      }
      const target = lane
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = {
          id: getRandomUUID(),
          options,
          lane: target,
          queuedDomains: domains,
          score:
            Date.now() +
            this.policy(options.resourceId).priorityAgingMs *
              Math.max(0, Math.min(3, options.priority ?? 1)),
          createdAt: Date.now(),
          agingMs: this.policy(options.resourceId).priorityAgingMs,
          controller: new AbortController(),
          run,
          resolve: (value) => resolve(value as T),
          reject,
          cleanup: () => {},
          drained: false,
          running: false,
        }
        const cancel = () =>
          this.cancel(entry, options.signal?.reason ?? new DOMException("Cancelled", "AbortError"))
        options.signal?.addEventListener("abort", cancel, { once: true })
        entry.cleanup = () => options.signal?.removeEventListener("abort", cancel)
        const waiting = this.waiting.get(key) ?? new Set<Entry>()
        waiting.add(entry)
        this.waiting.set(key, waiting)
        target.tasks.push(entry, entry.score)
        domains.forEach((d) => d.queued++)
        this.pending++
        this.counters.maxQueued = Math.max(this.counters.maxQueued, this.pending)
        this.refresh(target)
        options.onQueued?.((priority) => {
          if (entry.running || entry.drained) return
          entry.score = Math.min(
            entry.score,
            entry.createdAt + Math.max(0, Math.min(3, priority)) * entry.agingMs,
          )
          target.tasks.set(entry, entry.score)
          this.refresh(target)
          this.pump()
        })
        this.pump()
      })
    } catch (error) {
      options.onSettled?.()
      this.counters.rejected++
      return Promise.reject(error)
    }
  }

  cool(resourceId: string, until: number, scope: "credential" | "shared" = "shared") {
    const domains = this.currentDomains(resourceId)
    return this.coolDomains(domains, until, scope)
  }
  restoreCooldown(domainId: string, until: number) {
    const domain = this.domains.get(domainId)
    if (domain) this.coolDomains([domain], until, "credential")
  }
  private coolDomains(domains: Domain[], until: number, scope: "credential" | "shared") {
    const selected = scope === "credential" ? domains.slice(0, 1) : domains.slice(-1)
    for (const domain of selected) {
      domain.cooldownUntil = Math.max(domain.cooldownUntil, until)
      domain.tokens = Math.min(domain.tokens, 1)
      // Do not accumulate a full burst while cooling.
      domain.refillAt = Math.max(domain.refillAt, domain.cooldownUntil)
      for (const lane of this.lanes.values())
        if (this.requiredDomains(lane.resourceId).includes(domain)) this.refresh(lane)
    }
    this.pump()
    return selected.map((domain) => domain.id)
  }
  private currentDomains(resource: string) {
    return (this.paths.get(resource) ?? []).map((id) => this.domains.get(id)!).filter(Boolean)
  }
  private requiredDomains(resource: string) {
    return [
      ...new Set([
        ...this.currentDomains(resource),
        ...(this.transitions.get(resource)?.keys() ?? []),
      ]),
    ]
  }
  private refill(domain: Domain, now: number) {
    if (now <= domain.refillAt) return
    domain.tokens = Math.min(
      domain.policy.capacity,
      domain.tokens + ((now - domain.refillAt) * domain.policy.rate) / 1000,
    )
    domain.refillAt = now
  }
  private refresh(lane: Lane) {
    this.ready.remove(lane)
    for (const domain of lane.blocked) domain.waiters.delete(lane)
    lane.blocked.clear()
    const head = lane.tasks.peek()
    if (!head) {
      this.lanes.delete(lane.key)
      this.waiting.delete(lane.key)
      return
    }
    const now = Date.now()
    for (const domain of this.requiredDomains(lane.resourceId)) {
      this.counters.eligibilityChecks++
      this.refill(domain, now)
      const due = Math.max(
        domain.cooldownUntil,
        domain.tokens < 1
          ? now + Math.ceil(((1 - domain.tokens) * 1000) / domain.policy.rate)
          : now,
      )
      if (domain.active.size >= domain.policy.maxInFlight || due > now) {
        lane.blocked.add(domain)
        domain.waiters.add(lane)
        if (due > now && due < (this.wakeAt.get(domain) ?? Infinity)) {
          this.wakeAt.set(domain, due)
          this.deadlines.set(domain, due)
        }
      }
    }
    if (!lane.blocked.size) this.ready.set(lane, head.score)
  }
  private pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.active.size < this.global.maxInFlight) {
        const lane = this.ready.pop()
        if (!lane) break
        this.refresh(lane)
        if (lane.blocked.size) continue
        this.ready.remove(lane)
        const entry = lane.tasks.pop()
        if (!entry) continue
        this.dequeue(entry)
        try {
          entry.options.signal?.throwIfAborted()
          entry.options.assertCurrent?.()
          const domains = this.requiredDomains(entry.options.resourceId)
          if (!this.paths.has(entry.options.resourceId))
            throw new ResourceRejected("configuration-changed")
          // All checks precede ALL deductions. No await or partial resource acquisition.
          if (
            domains.some(
              (d) =>
                d.active.size >= d.policy.maxInFlight ||
                d.tokens < 1 ||
                d.cooldownUntil > Date.now(),
            )
          )
            throw new Error("Resource scheduler eligibility invariant violated")
          for (const domain of domains) {
            domain.tokens--
            domain.active.add(entry.id)
          }
          const active: Active = {
            entry,
            domains: new Set(domains),
            chargedDomains: new Set(domains),
            started: false,
            released: false,
          }
          this.active.set(entry.id, active)
          entry.running = true
          this.counters.admissions++
          this.counters.maxActive = Math.max(this.counters.maxActive, this.active.size)
          this.execute(active)
        } catch (error) {
          entry.cleanup()
          entry.drained = true
          entry.reject(error)
          entry.options.onSettled?.()
        }
        this.refresh(lane)
      }
    } finally {
      this.pumping = false
      this.arm()
    }
  }
  private dequeue(entry: Entry) {
    this.pending--
    for (const domain of entry.queuedDomains) domain.queued--
    this.waiting.get(entry.lane.key)?.delete(entry)
  }
  private execute(active: Active) {
    const { entry } = active
    const policy = this.policy(entry.options.resourceId)
    const attempts = entry.options.attempts ?? AttemptContext.create([entry.id])
    const permit: ExecutionPermit = {
      physicalRequestId: entry.id,
      cooldown: (until, scope) => this.coolDomains([...active.chargedDomains], until, scope),
      start: (beforeSend) => {
        entry.controller.signal.throwIfAborted()
        entry.options.assertCurrent?.()
        if (active.started || active.released || !attempts.canStart(policy.maxAttempts))
          throw new ResourceRejected("attempts")
        beforeSend?.()
        attempts.start(policy.maxAttempts)
        active.started = true
        this.counters.starts++
      },
    }
    const timeout = setTimeout(
      () => this.cancel(entry, new Error("Provider request timed out")),
      entry.options.timeoutMs ?? policy.timeoutMs,
    )
    let actual: Promise<unknown>
    try {
      actual = entry.run(entry.controller.signal, permit)
    } catch (error) {
      actual = Promise.reject(error)
    }
    void actual
      .then(
        (value) => {
          if (!entry.drained) entry.resolve(value)
        },
        (error) => {
          if (!entry.drained) entry.reject(error)
        },
      )
      .finally(() => {
        clearTimeout(timeout)
        entry.cleanup()
        this.release(active)
      })
  }
  private cancel(entry: Entry, reason: unknown) {
    if (entry.drained) return
    entry.drained = true
    this.counters.cancellations++
    entry.controller.abort(reason)
    entry.options.onAbort?.(reason)
    entry.reject(reason)
    if (!entry.running) {
      entry.lane.tasks.remove(entry)
      this.dequeue(entry)
      entry.cleanup()
      entry.options.onSettled?.()
      this.refresh(entry.lane)
      this.pump()
    }
    // Running entries remain physically occupied until their actual operation settles.
  }
  private release(active: Active) {
    if (active.released) return
    active.released = true
    const { entry } = active
    this.active.delete(entry.id)
    entry.options.onSettled?.()
    const wake = new Set<Lane>()
    for (const domain of active.domains) {
      domain.active.delete(entry.id)
      if (!active.started && active.chargedDomains.has(domain))
        domain.tokens = Math.min(domain.policy.capacity, domain.tokens + 1)
      for (const lane of domain.waiters) wake.add(lane)
    }
    const transition = this.transitions.get(entry.options.resourceId)
    if (transition) {
      for (const [domain, holders] of transition) {
        holders.delete(entry.id)
        if (!holders.size) transition.delete(domain)
      }
      if (!transition.size) this.transitions.delete(entry.options.resourceId)
    }
    wake.forEach((lane) => this.refresh(lane))
    this.collect(active.domains)
    this.pump()
  }
  private arm() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending) {
      this.deadlines.clear()
      this.wakeAt.clear()
      return
    }
    const domain = this.deadlines.peek()
    if (!domain) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        const now = Date.now()
        while (
          this.deadlines.peek() &&
          (this.wakeAt.get(this.deadlines.peek()!) ?? Infinity) <= now
        ) {
          const due = this.deadlines.pop()!
          this.wakeAt.delete(due)
          for (const lane of [...due.waiters]) this.refresh(lane)
        }
        this.pump()
      },
      Math.max(1, Math.min(2_147_483_647, (this.wakeAt.get(domain) ?? Date.now()) - Date.now())),
    )
  }
  private collect(candidates: Iterable<Domain> = this.domains.values()) {
    for (const domain of candidates)
      if (
        !this.referenced.has(domain.id) &&
        !domain.active.size &&
        !domain.queued &&
        !domain.waiters.size &&
        domain.cooldownUntil <= Date.now()
      ) {
        this.domains.delete(domain.id)
        this.deadlines.remove(domain)
        this.wakeAt.delete(domain)
      }
  }
  inspect() {
    return {
      active: this.active.size,
      queued: this.pending,
      lanes: this.lanes.size,
      timers: this.timer ? 1 : 0,
      counters: { ...this.counters },
      domains: Object.fromEntries(
        [...this.domains].map(([id, d]) => [
          id,
          {
            active: d.active.size,
            queued: d.queued,
            tokens: d.tokens,
            cooldownUntil: d.cooldownUntil,
          },
        ]),
      ),
    }
  }
}
