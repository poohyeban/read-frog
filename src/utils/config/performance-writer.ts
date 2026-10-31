import type { PerformanceOverrides } from "@/utils/request/performance-config"
import type { PerformancePatch } from "@/utils/request/performance-patch"
import {
  emptyPerformanceOverrides,
  validatePerformanceOverrides,
} from "@/utils/request/performance-config"
import { applyPerformancePatch } from "@/utils/request/performance-patch"
import { resolveResourceRegistry } from "@/utils/request/resource-registry"

interface WriterStorage {
  read: () => Promise<unknown>
  write: (value: PerformanceOverrides) => Promise<void>
  context: () => Promise<{
    identities: ReadonlyMap<string, string>
    providerIds: ReadonlySet<string>
    /** All configured identities, including disabled aliases. Absent on resolution failure. */
    resourceIds?: ReadonlySet<string>
  }>
}

/** Only the background owns this writer. Each patch reads after the preceding commit. */
export function createPerformanceWriter(storage: WriterStorage) {
  let pending: Promise<unknown> = Promise.resolve()
  function update(patch?: PerformancePatch): Promise<PerformanceOverrides> {
    const operation = pending.then(async () => {
      const stored = await storage.read()
      const current =
        stored === null || stored === undefined
          ? emptyPerformanceOverrides()
          : validatePerformanceOverrides(stored)
      const { identities, providerIds, resourceIds } =
        patch?.kind === "reset-all"
          ? { identities: new Map<string, string>(), providerIds: new Set<string>() }
          : await storage.context()
      const next = patch
        ? applyPerformancePatch(current, patch, identities, providerIds)
        : reconcile(current, providerIds, resourceIds)
      if (!next) return current
      // Validate inherited group/alias constraints as well as each sparse record.
      resolveResourceRegistry(identities, next)
      await storage.write(next)
      return next
    })
    pending = operation.catch(() => {})
    return operation
  }
  return { patch: (patch: PerformancePatch) => update(patch), reconcile: () => update() }
}

function reconcile(
  current: PerformanceOverrides,
  providerIds: ReadonlySet<string>,
  resourceIds?: ReadonlySet<string>,
) {
  const next = structuredClone(current)
  for (const id of Object.keys(next.providers ?? {}))
    if (!providerIds.has(id)) delete next.providers![id]
  if (next.providers && !Object.keys(next.providers).length) delete next.providers
  if (resourceIds)
    for (const group of Object.values(next.groups ?? {}))
      group.members = group.members.filter((id) => resourceIds.has(id))
  // An empty group retains the user's name/policy for explicit rebinding. Do not
  // alter historical vault bindings or translation/database migration history.
  if (JSON.stringify(next) === JSON.stringify(current)) return null
  next.revision++
  return validatePerformanceOverrides(next)
}
