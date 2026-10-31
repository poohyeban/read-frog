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
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { getExecutionContext } from "@/utils/request/execution-context"
import { RequestQueue } from "@/utils/request/request-queue"
import { ResourceRejected } from "@/utils/request/resource-error"
import {
  ResourceIdentityResolver,
  isIdentityVault,
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
  hasBindings: async () => Object.keys(getPerformanceOverrides().groups ?? {}).length > 0,
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
let initialize: Promise<void> | undefined
let updates: Promise<void> = Promise.resolve()
let watching = false
let revision = 0
let failure: unknown
let cooling: Record<string, number> = {}

function refresh(config: Config | null) {
  const next = new Map((config?.providersConfig ?? []).map((p) => [p.id, p]))
  // Invalidate obsolete queued transport snapshots synchronously, before async identity work.
  configs = next
  revisions = new Map([...next].map(([id, p]) => [id, providerTransportRevision(p)]))
  updates = updates
    .catch(() => {})
    .then(async () => {
      await resolver.initialize()
      const resolved = new Map<string, string>()
      for (const [id, provider] of configs) {
        if (!provider.enabled) continue
        try {
          resolved.set(
            id,
            await resolver.update(id, revisions.get(id)!, providerIdentityMaterial(provider)),
          )
        } catch {
          /* An unconfigured endpoint cannot disable unrelated providers. */
        }
      }
      for (const id of identities.keys()) if (!resolved.has(id)) resolver.remove(id)
      identities = resolved
      const registry = resolveResourceRegistry(identities, getPerformanceOverrides())
      providerResourceScheduler.configure(registry.domains, registry.paths, registry.global)
      for (const [domain, until] of Object.entries(cooling)) {
        if (Number.isFinite(until) && until > Date.now())
          providerResourceScheduler.restoreCooldown(domain, until)
        else delete cooling[domain]
      }
      failure = undefined
    })
    .catch((error) => {
      failure = error
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
        void refresh({ providersConfig: [...configs.values()] } as Config).catch(() => {})
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

export async function getResourceProvider(providerId: string) {
  await initializeProviderResources()
  await updates
  const provider = configs.get(providerId)
  if (!provider?.enabled || !identities.has(providerId))
    throw new ResourceRejected("configuration-changed")
  return provider
}

export function getResourceIdentities() {
  return new Map(identities)
}

/** The sole remote-operation authority. Local/cache work never enters here. */
export async function runProviderOperation<T>(
  provider: LLMProviderConfig,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal, permit: ExecutionPermit) => Promise<T>,
  beforeSend?: () => void,
): Promise<T> {
  await initializeProviderResources()
  await updates
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
      !configs.get(provider.id)?.enabled
    )
      throw new ResourceRejected("configuration-changed")
  }
  assertCurrent()
  context.resourceId = id
  context.policy ??= providerResourceScheduler.policy(id!)
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
