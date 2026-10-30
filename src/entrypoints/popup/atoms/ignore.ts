import { atom } from "jotai"
import { popupTabAtom } from "./session"

export function isIgnoreUrl(url: string): boolean {
  try {
    return !["http:", "https:", "file:"].includes(new URL(url).protocol)
  } catch {
    return true
  }
}

export const isIgnoreTabAtom = atom((get) => isIgnoreUrl(get(popupTabAtom)?.url ?? ""))
