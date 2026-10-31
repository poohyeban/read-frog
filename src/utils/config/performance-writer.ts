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
  }>
}

/** Only the background owns this writer. Each patch reads after the preceding commit. */
export function createPerformanceWriter(storage: WriterStorage) {
  let pending: Promise<unknown> = Promise.resolve()
  return {
    patch(patch: PerformancePatch): Promise<PerformanceOverrides> {
      const operation = pending.then(async () => {
        const stored = await storage.read()
        const current =
          stored === null || stored === undefined
            ? emptyPerformanceOverrides()
            : validatePerformanceOverrides(stored)
        const { identities, providerIds } =
          patch.kind === "reset-all"
            ? { identities: new Map<string, string>(), providerIds: new Set<string>() }
            : await storage.context()
        const next = applyPerformancePatch(current, patch, identities, providerIds)
        if (!next) return current
        // Validate inherited group/alias constraints as well as each sparse record.
        resolveResourceRegistry(identities, next)
        await storage.write(next)
        return next
      })
      pending = operation.catch(() => {})
      return operation
    },
  }
}
