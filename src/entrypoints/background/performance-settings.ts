import { storage } from "#imports"
import { initializePerformance, getPerformanceOverrides } from "@/utils/config/performance"
import { createPerformanceWriter } from "@/utils/config/performance-writer"
import { onMessage } from "@/utils/message"
import {
  getProviderResourceSnapshot,
  providerResourceScheduler,
} from "@/utils/providers/resource-runtime"
import { PERFORMANCE_STORAGE_KEY } from "@/utils/request/performance-config"

const writer = createPerformanceWriter({
  read: () => storage.getItem(PERFORMANCE_STORAGE_KEY),
  write: (value) => storage.setItem(PERFORMANCE_STORAGE_KEY, value),
  context: getProviderResourceSnapshot,
})

export function setupPerformanceSettings() {
  onMessage("getProviderResourcePolicy", async ({ data }) => {
    const { identities } = await getProviderResourceSnapshot()
    const resource = identities.get(data.providerId)
    return resource ? providerResourceScheduler.policy(resource) : null
  })
  onMessage("getPerformanceConfiguration", async () => {
    await initializePerformance()
    const { identities } = await getProviderResourceSnapshot()
    // Opaque identities only; no endpoint, auth fingerprint or installation secret.
    return { overrides: getPerformanceOverrides(), identities: Object.fromEntries(identities) }
  })
  onMessage("patchPerformanceConfiguration", ({ data }) => writer.patch(data))
}
