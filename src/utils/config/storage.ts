import type { Config } from "@/types/config/config"
import type { ConfigMeta } from "@/types/config/meta"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../constants/config"
import { logger } from "../logger"
import { copyConfigSnapshot, noteCurrentConfigSnapshot } from "./snapshot-revision"

let configRevision = 0
let validatedConfig: Config | null | undefined
let pendingRead: { revision: number; promise: Promise<Config | null> } | undefined
let watching = false

function invalidateConfig(config?: Config | null): void {
  noteCurrentConfigSnapshot(config)
  configRevision++
  validatedConfig = undefined
  pendingRead = undefined
}

export async function getLocalConfig(): Promise<Config | null> {
  if (!watching) {
    watching = true
    storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, invalidateConfig)
  }
  if (validatedConfig !== undefined)
    return validatedConfig && copyConfigSnapshot(validatedConfig, configRevision)
  const revision = configRevision
  if (!pendingRead) {
    const promise = storage
      .getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
      .then((config) => {
        let result: Config | null = null
        if (!config) logger.warn("No config found in storage")
        else {
          const parsed = configSchema.safeParse(config)
          if (!parsed.success) logger.error("Config is invalid, using default config")
          result = parsed.success ? parsed.data : DEFAULT_CONFIG
        }
        if (revision === configRevision) {
          validatedConfig = result
          noteCurrentConfigSnapshot(result)
        }
        return result
      })
      .finally(() => {
        if (pendingRead?.revision === revision) pendingRead = undefined
      })
    pendingRead = { revision, promise }
  }
  const config = await pendingRead.promise
  // Existing UI callers are allowed to edit their returned copy. An in-flight
  // request's copy is never mutated by a later storage update or another caller.
  return config && copyConfigSnapshot(config, revision)
}

export async function setLocalConfig(config: Config) {
  const parsedConfig = configSchema.safeParse(config)
  if (!parsedConfig.success) {
    throw new Error("Config is invalid")
  }
  invalidateConfig(parsedConfig.data)
  await storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, parsedConfig.data)
  await storage.setMeta<Partial<ConfigMeta>>(`local:${CONFIG_STORAGE_KEY}`, {
    lastModifiedAt: Date.now(),
  })
}
