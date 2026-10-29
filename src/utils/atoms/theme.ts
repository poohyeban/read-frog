import type { ThemeMode } from "@/types/config/theme"
import { atom } from "jotai"
import { DEFAULT_THEME_MODE, themeModeSchema } from "@/types/config/theme"
import { storageAdapter } from "../config/storage-adapter"
import { THEME_STORAGE_KEY } from "../constants/config"
import {
  isExtensionContextAlive,
  isExtensionContextInvalidatedError,
} from "../error/extension-context"
import { logger } from "../logger"

// Private base atom. Only export this for top-level hydration before ThemeProvider mounts.
export const baseThemeModeAtom = atom<ThemeMode>(DEFAULT_THEME_MODE)

// Public atom with read/write - write always goes through storageAdapter
export const themeModeAtom = atom(
  (get) => get(baseThemeModeAtom),
  async (get, set, newValue: ThemeMode) => {
    const prev = get(baseThemeModeAtom)
    set(baseThemeModeAtom, newValue)
    try {
      await storageAdapter.set(THEME_STORAGE_KEY, newValue, themeModeSchema)
    } catch (error) {
      console.error("Failed to set themeMode to storage:", newValue, error)
      set(baseThemeModeAtom, prev)
    }
  },
)

baseThemeModeAtom.onMount = (setAtom: (newValue: ThemeMode) => void) => {
  let active = true
  const refresh = async () => {
    if (!active || !isExtensionContextAlive()) return
    try {
      const theme = await storageAdapter.get(THEME_STORAGE_KEY, DEFAULT_THEME_MODE, themeModeSchema)
      if (active) setAtom(theme)
    } catch (error) {
      // An update can invalidate storage while this read is in flight. Keep the
      // existing theme, and never leave visibility-event promises unhandled.
      if (!isExtensionContextInvalidatedError(error)) {
        logger.warn("Failed to refresh theme from storage")
      }
    }
  }
  void refresh()
  const unwatch = storageAdapter.watch<ThemeMode>(THEME_STORAGE_KEY, setAtom)

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      logger.info("baseThemeModeAtom onMount handleVisibilityChange when: ", new Date())
      void refresh()
    }
  }
  document.addEventListener("visibilitychange", handleVisibilityChange)

  return () => {
    active = false
    unwatch()
    document.removeEventListener("visibilitychange", handleVisibilityChange)
  }
}
