import type { Hotkey } from "@tanstack/hotkeys"
import type { TranslationCommands } from "@/utils/host/translate/engine-state"
import { HotkeyManager } from "@tanstack/hotkeys"
import { getLocalConfig } from "@/utils/config/storage"
import { isShortcutEmpty, isValidShortcut } from "@/utils/shortcut"

/**
 * Binds page translation shortcut key from the given config.
 * Uses sync cached config inside the hotkey callback to avoid async overhead.
 */
export async function bindTranslationShortcutKey(pageTranslationManager: TranslationCommands) {
  const config = await getLocalConfig()
  if (!config || isShortcutEmpty(config.pageTranslation.page.shortcut)) {
    return () => {}
  }

  const shortcut = config.pageTranslation.page.shortcut
  if (!isValidShortcut(shortcut)) {
    return () => {}
  }

  const registration = HotkeyManager.getInstance().register(
    shortcut as Hotkey,
    () => {
      if (pageTranslationManager.isActive) {
        pageTranslationManager.stop({ userInitiated: true })
      } else {
        void pageTranslationManager.start()
      }
    },
    {
      ignoreInputs: true,
      preventDefault: true,
      stopPropagation: true,
    },
  )

  return () => {
    registration.unregister()
  }
}
