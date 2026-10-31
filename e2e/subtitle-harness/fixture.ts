import { atom } from "jotai"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
;(window as any).__config ??= structuredClone(DEFAULT_CONFIG)
export const configFieldsAtomMap = { videoSubtitles: atom({ style: { displayMode: "bilingual" } }) }
export async function getLocalConfig() {
  return structuredClone((window as any).__config ?? DEFAULT_CONFIG)
}
export const i18n = { t: (key: string) => key }
export async function sendMessage() {}

export const ROOT_VIEW = "root"
export const DEFAULT_SECTION_ID = "transcript"

export const browser = { runtime: { id: "subtitle-benchmark" } }
const stored = new Map<string, unknown>()
const watchers = new Map<string, Set<(value: any, old: any) => void>>()
export const storage = {
  async getItem(key: string) {
    return stored.get(key) ?? (key === "local:config" ? await getLocalConfig() : null)
  },
  async setItem(key: string, value: unknown) {
    const old = stored.get(key)
    stored.set(key, value)
    for (const listener of watchers.get(key) ?? []) listener(value, old)
  },
  async setItems(items: { key: string; value: unknown }[]) {
    for (const item of items) await this.setItem(item.key, item.value)
  },
  watch(key: string, listener: (value: any, old: any) => void) {
    const listeners = watchers.get(key) ?? new Set()
    listeners.add(listener)
    watchers.set(key, listeners)
    return () => listeners.delete(listener)
  },
}

export const ensureInitializedConfig = getLocalConfig
