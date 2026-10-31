import { initializePerformance, getPerformanceOverrides } from "@/utils/config/performance"
import { onMessage } from "@/utils/message"
import {
  getProviderResourceSnapshot,
  providerResourceScheduler,
  resourcePerformanceWriter,
} from "@/utils/providers/resource-runtime"

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
  onMessage("patchPerformanceConfiguration", ({ data }) => resourcePerformanceWriter.patch(data))
}
