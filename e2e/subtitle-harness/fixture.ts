import { atom } from "jotai"
export const configFieldsAtomMap = { videoSubtitles: atom({ style: { displayMode: "bilingual" } }) }
export async function getLocalConfig() {
  return structuredClone((window as any).__config)
}
export const i18n = { t: (key: string) => key }
export async function sendMessage() {}

export const ROOT_VIEW = "root"
export const DEFAULT_SECTION_ID = "transcript"

export const browser = { runtime: { id: "subtitle-benchmark" } }
export const storage = { watch: () => () => {} }
