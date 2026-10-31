import { atom } from "jotai"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
export const configFieldsAtomMap = { videoSubtitles: atom({ style: { displayMode: "bilingual" } }) }
export async function getLocalConfig() {
  return structuredClone((window as any).__config ?? DEFAULT_CONFIG)
}
export const i18n = { t: (key: string) => key }
export async function sendMessage() {}

export const ROOT_VIEW = "root"
export const DEFAULT_SECTION_ID = "transcript"

export const browser = { runtime: { id: "subtitle-benchmark" } }
export const storage = { watch: () => () => {} }

export const ensureInitializedConfig = getLocalConfig
