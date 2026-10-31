import type { Config } from "@/types/config/config"
import { storage } from "#imports"
import { ensureConfigInitialized } from "@/utils/config/init"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"

// To avoid background script initialize config simultaneously and avoid race condition
export async function ensureInitializedConfig() {
  await ensureConfigInitialized()
  return storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
}

/**
 * Whether the config was created from defaults in this run, rather than loaded from storage.
 * Shares the memoized initialization above, so it never triggers a second init.
 */
