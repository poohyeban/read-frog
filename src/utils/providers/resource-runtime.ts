import type { Config } from "@/types/config/config"
import type { LLMProviderConfig } from "@/types/config/provider"
import type { ExecutionPermit } from "@/utils/request/resource-scheduler"
import { storage } from "#imports"
import { ensureConfigInitialized } from "@/utils/config/init"
import {
  getPerformanceOverrides,
  initializePerformance,
  watchPerformance,
} from "@/utils/config/performance"
import { createPerformanceWriter } from "@/utils/config/performance-writer"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { freezeData } from "@/utils/immutable"
import { getExecutionContext } from "@/utils/request/execution-context"
import { PERFORMANCE_STORAGE_KEY } from "@/utils/request/performance-config"
import { RequestQueue } from "@/utils/request/request-queue"
import { ResourceRejected } from "@/utils/request/resource-error"
import {
  ResourceIdentityResolver,
  isIdentityVault,
  normalizeResourceEndpoint,
  type IdentityVault,
} from "@/utils/request/resource-identity"
import { RESOURCE_DEFAULTS } from "@/utils/request/resource-policy"
import { resolveResourceRegistry } from "@/utils/request/resource-registry"
import { ResourceScheduler } from "@/utils/request/resource-scheduler"
import { getRequestErrorMeta, getRetryAfterMs } from "@/utils/request/retry-policy"
import { providerIdentityMaterial, providerTransportRevision } from "./resource-material"

const IDENTITY_STORAGE = "local:resourceIdentityVault" as const
const IDENTITY_RECOVERY_STORAGE = "local:resourceIdentityRecovery" as const
const COOLING_STORAGE = "session:resourceCooldowns" as const
const writeIdentity = (value: IdentityVault) =>
  storage.setItems([
    { key: IDENTITY_STORAGE, value },
    { key: IDENTITY_RECOVERY_STORAGE, value },
  ])
const resolver = new ResourceIdentityResolver({
  read: async () => {
    const [primary, recovery] = await Promise.all([
      storage.getItem(IDENTITY_STORAGE),
      storage.getItem(IDENTITY_RECOVERY_STORAGE),
    ])
    if (isIdentityVault(primary)) {
      if (
        isIdentityVault(recovery) &&
        (primary.secret !== recovery.secret || primary.namespace !== recovery.namespace)
      )
        throw new ResourceRejected("identity")
      if (!isIdentityVault(recovery)) await writeIdentity(primary)
      return primary
    }
    if (isIdentityVault(recovery)) {
      await writeIdentity(recovery)
      return recovery
    }
    return primary ?? recovery
  },
  write: writeIdentity,
  hasBindings: async () =>
    Object.values(getPerformanceOverrides().groups ?? {}).some((g) => g.members.length > 0),
})
export const providerResourceScheduler = new ResourceScheduler()
const directRequests = new RequestQueue({
  timeoutMs: RESOURCE_DEFAULTS.timeoutMs,
  maxRetries: RESOURCE_DEFAULTS.maxAttempts - 1,
  baseRetryDelayMs: RESOURCE_DEFAULTS.baseRetryDelayMs,
  maxQueued: 256,
  consumer: "interactive",
})
let configs = new Map<string, LLMProviderConfig>()
let revisions = new Map<string, string>()
let identities = new Map<string, string>()
let configuredIdentities = new Map<string, string>()
let resourceIds: Set<string> | undefined
let identityRevisions = new Map<string, string>()
let refreshGeneration = 0
let initialize: Promise<void> | undefined
let updates: Promise<void> = Promise.resolve()
let watching = false
let hasConfiguration = false
let revision = 0
let failure: unknown
let cooling: Record<string, number> = {}

// User patches and configuration reconciliation share one serialized writer.
export const resourcePerformanceWriter = createPerformanceWriter({
  read: () => storage.getItem(PERFORMANCE_STORAGE_KEY),
  write: (value) => storage.setItem(PERFORMANCE_STORAGE_KEY, value),
  context: getProviderResourceSnapshot,
})

function refresh(config: Config | null) {
  hasConfiguration = config !== null
  const generation = ++refreshGeneration
  const next = new Map(
    (config?.providersConfig ?? []).map((p) => [p.id, freezeData(structuredClone(p))]),
  )
  const nextRevisions = new Map([...next].map(([id, p]) => [id, providerTransportRevision(p)]))
  // Invalidate obsolete queued transport snapshots synchronously, before async identity work.
  configs = next
  revisions = nextRevisions
  updates = updates
    .catch(() => {})
    .then(async () => {
      if (generation !== refreshGeneration) return
      if (!config) throw new ResourceRejected("configuration-changed")
      await resolver.initialize()
      if (generation !== refreshGeneration) return
      const resolved = new Map<string, string>()
      let complete = true
      for (const [id, provider] of next) {
        let material
        try {
          material = providerIdentityMaterial(provider)
          normalizeResourceEndpoint(material.endpoint)
        } catch {
          // An unconfigured/invalid endpoint is not a live reference.
          continue
        }
        try {
          resolved.set(id, await resolver.update(id, nextRevisions.get(id)!, material))
        } catch {
          // HMAC/storage failures do not prove a saved member is unreferenced.
          complete = false
        }
        if (generation !== refreshGeneration) return
      }
      for (const id of configuredIdentities.keys()) if (!resolved.has(id)) resolver.remove(id)
      configuredIdentities = resolved
      resourceIds = complete ? new Set(resolved.values()) : undefined
      identities = new Map([...resolved].filter(([id]) => next.get(id)?.enabled))
      identityRevisions = nextRevisions
      const registry = resolveResourceRegistry(identities, getPerformanceOverrides())
      providerResourceScheduler.configure(registry.domains, registry.paths, registry.global)
      directRequests.setQueueOptions({ maxQueued: registry.global.maxQueued })
      for (const [domain, until] of Object.entries(cooling)) {
        if (Number.isFinite(until) && until > Date.now())
          providerResourceScheduler.restoreCooldown(domain, until)
        else delete cooling[domain]
      }
      failure = undefined
      // Do not await here: a queued UI edit can itself be waiting for this refresh.
      void resourcePerformanceWriter.reconcile().catch(() => {})
    })
    .catch((error) => {
      if (generation === refreshGeneration) failure = error
      throw error
    })
  void updates.catch(() => {})
  return updates
}

export function initializeProviderResources() {
  initialize ??= (async () => {
    await ensureConfigInitialized()
    await initializePerformance()
    if (!watching) {
      watching = true
      storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (config) => {
        revision++
        void refresh(config).catch(() => {})
      })
      watchPerformance(() => {
        void refresh(
          hasConfiguration ? ({ providersConfig: [...configs.values()] } as Config) : null,
        ).catch(() => {})
      })
    }
    const captured = revision
    const [config, persisted] = await Promise.all([
      getLocalConfig(),
      storage.getItem<typeof cooling>(COOLING_STORAGE),
    ])
    cooling = persisted ?? {}
    if (revision === captured) await refresh(config)
    else await updates
  })().catch((error) => {
    initialize = undefined
    throw error
  })
  return initialize
}

/** A waiter must follow updates queued while an older HMAC/write was suspended. */
async function waitForCurrentResources() {
  await initializeProviderResources()
  while (true) {
    const pending = updates
    try {
      await pending
    } catch (error) {
      if (pending === updates) throw error
    }
    if (pending === updates) return { configs, identities, configuredIdentities, resourceIds }
  }
}

export async function getResourceProvider(providerId: string) {
  const snapshot = await waitForCurrentResources()
  const provider = snapshot.configs.get(providerId)
  if (!provider?.enabled || !snapshot.identities.has(providerId))
    throw new ResourceRejected("configuration-changed")
  return provider
}

export function getResourceIdentities() {
  return new Map(identities)
}
export async function getProviderResourceSnapshot() {
  const snapshot = await waitForCurrentResources()
  return {
    identities: new Map(snapshot.identities),
    configuredIdentities: new Map(snapshot.configuredIdentities),
    providerIds: new Set(snapshot.configs.keys()),
    resourceIds: snapshot.resourceIds && new Set(snapshot.resourceIds),
    isCurrent: () =>
      snapshot.configs === configs && snapshot.configuredIdentities === configuredIdentities,
  }
}

/** The sole remote-operation authority. Local/cache work never enters here. */
export async function runProviderOperation<T>(
  provider: LLMProviderConfig,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal, permit: ExecutionPermit) => Promise<T>,
  beforeSend?: () => void,
): Promise<T> {
  await waitForCurrentResources()
  signal?.throwIfAborted()
  const context = getExecutionContext(signal)
  if (!context) {
    const scope = `remote:${getRandomUUID()}`
    const cancel = () => directRequests.cancelByScope(scope)
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      return await directRequests.enqueue(
        (s) => runProviderOperation(provider, s, operation, beforeSend),
        Date.now(),
        scope,
        [scope],
      )
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
  }
  const id = identities.get(provider.id)
  const captured = providerTransportRevision(provider)
  const assertCurrent = () => {
    signal?.throwIfAborted()
    if (
      failure ||
      !id ||
      identities.get(provider.id) !== id ||
      revisions.get(provider.id) !== captured ||
      identityRevisions.get(provider.id) !== captured ||
      !configs.get(provider.id)?.enabled
    )
      throw new ResourceRejected("configuration-changed")
  }
  assertCurrent()
  context.resourceId = id
  context.policy = providerResourceScheduler.policy(id!)
  let settled!: () => void
  context.physicalSettled = new Promise<void>((resolve) => {
    settled = resolve
  })
  return providerResourceScheduler.run(
    {
      resourceId: id!,
      consumer: context.consumer,
      priority: context.priority,
      signal,
      attempts: context.attempts,
      timeoutMs: context.timeoutMs,
      assertCurrent,
      onSettled: settled,
      onAbort: context.abort,
      onQueued: (promote) => {
        context.promote = promote
      },
    },
    async (activeSignal, permit) => {
      try {
        return await operation(activeSignal, {
          physicalRequestId: permit.physicalRequestId,
          start: () => permit.start(beforeSend),
        })
      } catch (error) {
        const meta = getRequestErrorMeta(error)
        if (meta.statusCode === 429 || meta.kind === "rate-limit") {
          const until = Date.now() + (getRetryAfterMs(meta) ?? context.policy!.cooldownMs)
          // Adapter-supplied scope wins; unknown scope cools the actual granted group.
          const scope = meta.rateLimitScope ?? "shared"
          for (const domain of permit.cooldown?.(until, scope) ?? [])
            cooling[domain] = Math.max(until, cooling[domain] ?? 0)
          // A late response after cancellation still updates shared cooldown.
          await storage.setItem(COOLING_STORAGE, cooling).catch(() => {})
        }
        throw error
      }
    },
  )
}
